/**
 * WP-TG: защита процесса харнеса от кода бота, который выполняется прямо в нём. Это группы units (TG.8, TG.10, TG.16–TG.19),
 * vm (TG.6, TG.6-tg) и юнит-части TG.23 (makeHeartbeat, loadConfig, makeLogger). Ошибка в незаконченном коде шага 5 должна
 * дать RED своей проверки, а не уронить или испортить весь прогон: итоговая таблица и сверка с baseline печатаются в самом конце.
 *
 * `guardRun(id, fn)` на время fn («окно проверки»):
 *  - unhandledRejection и uncaughtException (исключение из таймера или слушателя) записываются в проблемы окна, процесс не падает;
 *  - globalThis.fetch заменён заглушкой: она записывает URL и бросает исключение — ядро ходит в сеть только через внедрённый
 *    fetch (§4.4), а настоящий запрос из процесса харнеса не уходит;
 *  - process.exit заменён заглушкой: она записывает код и бросает исключение — код бота не завершает процесс харнеса
 *    (loadConfig обязан бросать, makeHeartbeat — звать внедрённый exit);
 *  - после fn — хвост tailMs (200 мс): отказы из таймеров, поставленных кодом бота, успевают всплыть в своём окне.
 * В finally fetch и process.exit возвращаются.
 *
 * Обработчики событий процесса ставятся один раз, при первом окне, то есть только когда код бота реально выполняется:
 * отказы других WP до TG по-прежнему роняют процесс, как раньше. Дальше обработчики остаются. Событие вне окна (таймер бота
 * сработал после конца проверки) копится как «позднее», сразу пишется в stderr и попадает ✗-пунктом в следующее окно
 * с пометкой, после какой проверки оно пришло. Так прогон доходит до таблицы и сверки с baseline.
 *
 * Не ловится: синхронный бесконечный цикл в коде бота (процесс харнеса занят, таймеры не срабатывают). От него защищают только
 * дочерние процессы с таймаутом (группы server и parity).
 */
import type { Verdict } from "../lib";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => { const t = oneLine(s); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const errText = (e: unknown) => cut(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 300);
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** «N: a; b ×3; …» — одинаковые записи схлопнуты со счётом (таймер мутанта бросает одно и то же на каждый ход) */
const listOf = (xs: readonly string[], n = 3) => {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  const items = [...counts].map(([x, k]) => (k > 1 ? `${x} ×${k}` : x));
  return `${xs.length}: ${items.slice(0, n).join("; ")}${items.length > n ? `; … ещё ${items.length - n} разных` : ""}`;
};

type Kind = "unhandledRejection" | "uncaughtException";
interface Ctx { id: string; unhandled: string[]; uncaught: string[]; fetches: string[]; exits: string[]; late: string[] }
interface State { installed: boolean; current: Ctx | null; lastId: string; late: { kind: Kind; after: string; text: string }[] }

/** Состояние на globalThis: модуль мог бы загрузиться дважды под разными URL — обработчики процесса и окно всё равно одни */
const KEY = Symbol.for("so.audit.tg.guard.v1");
function st(): State {
  const g = globalThis as typeof globalThis & { [KEY]?: State };
  return (g[KEY] ??= { installed: false, current: null, lastId: "", late: [] });
}

function onStray(kind: Kind, e: unknown): void {
  const s = st();
  const text = errText(e);
  const c = s.current;
  if (c) { (kind === "unhandledRejection" ? c.unhandled : c.uncaught).push(text); return; }
  const after = s.lastId || "(окон ещё не было)";
  s.late.push({ kind, after, text });
  // никогда не молча: следующей TG-проверки под защитой может и не быть (после TG.23 код бота в процессе не выполняется)
  try { process.stderr.write(`WP-TG: ${kind} из кода бота вне окна проверки (после ${after}): ${text}\n`); } catch { /* stderr закрыт */ }
}

function install(): void {
  const s = st();
  if (s.installed) return;
  s.installed = true;
  process.on("unhandledRejection", (r) => onStray("unhandledRejection", r));
  process.on("uncaughtException", (e) => onStray("uncaughtException", e));
}

/** Пункт проверки: имя, итог, пояснение — та же форма, что Sub в checks-units.ts и checks-vm.ts */
export interface GuardItem { name: string; ok: boolean; text: string }

/** Проблемы окна как ✗-пункты; забранное очищается (второй раз в итог не попадёт) */
function takeIssues(c: Ctx): GuardItem[] {
  const out: GuardItem[] = [];
  const take = (xs: string[]) => xs.splice(0, xs.length);
  const un = take(c.unhandled), ex = take(c.uncaught), fe = take(c.fetches), exits = take(c.exits), late = take(c.late);
  if (un.length) out.push({ name: "unhandledRejection в коде бота (main.ts зовёт handleUpdate без await — у бота это падение процесса)", ok: false, text: listOf(un) });
  if (ex.length) out.push({ name: "исключение вне await в коде бота (таймер/слушатель)", ok: false, text: listOf(ex) });
  if (fe.length) out.push({ name: "ядро обратилось к глобальному fetch (§4.4: в сеть — только через внедрённый fetch)", ok: false, text: listOf(fe.map((u) => cut(u, 120))) });
  if (exits.length) out.push({ name: "process.exit из кода бота в процессе харнеса", ok: false, text: listOf(exits.map((x) => `process.exit(${x})`)) });
  if (late.length) out.push({ name: "поздние отказы из кода бота прошлой проверки (пришли после её окна; к этой проверке не относятся, но код бота их порождает)", ok: false, text: listOf(late) });
  return out;
}

export interface GuardWindow {
  readonly id: string;
  /**
   * Дождаться хвоста (по умолчанию 200 мс) и забрать накопленные проблемы как пункты проверки: ✗ на каждую проблему или один ✓,
   * если их нет. Забранное в итог guardRun второй раз не попадёт; то, что придёт позже, guardRun вернёт в `rest`.
   */
  settle(tailMs?: number): Promise<GuardItem[]>;
}

export type GuardResult<T> = ({ ok: true; v: T } | { ok: false; error: unknown }) & {
  /** проблемы окна, не забранные через settle(): ✗-пункты для withGuard */
  rest: GuardItem[];
};

const ITEM_OK = "защита процесса харнеса: нет unhandledRejection, исключений вне await, обращений к глобальному fetch, process.exit и поздних отказов";

/**
 * Выполнить fn в окне проверки id (см. шапку). Исключение fn не пробрасывается, а возвращается в `error`.
 * @param o.tailMs   хвост после fn (по умолчанию 200 мс; если fn уже звала settle() — 20 мс)
 * @param o.exitHint что ожидалось вместо process.exit — в текст исключения заглушки
 */
export async function guardRun<T>(id: string, fn: (w: GuardWindow) => Promise<T>, o: { tailMs?: number; exitHint?: string } = {}): Promise<GuardResult<T>> {
  install();
  const s = st();
  if (s.current) throw new Error(`дефект харнеса: guardRun(${id}) внутри окна ${s.current.id}`);
  const ctx: Ctx = {
    id, unhandled: [], uncaught: [], fetches: [], exits: [],
    late: s.late.splice(0).map((x) => `${x.kind} после окна ${x.after}: ${x.text}`),
  };
  const savedFetch = globalThis.fetch;
  const savedExit = process.exit;
  let settled = false;
  const w: GuardWindow = {
    id,
    async settle(tailMs = 200) {
      await tick(tailMs);
      settled = true;
      const issues = takeIssues(ctx);
      return issues.length ? issues : [{ name: ITEM_OK, ok: true, text: "" }];
    },
  };
  s.current = ctx;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    ctx.fetches.push(u);
    throw new Error(`аудит WP-TG: глобальный fetch запрещён — ядро ходит в сеть только через внедрённый fetch (§4.4); запрос ${cut(u, 100)}`);
  }) as typeof fetch;
  process.exit = ((code?: number | string | null) => {
    ctx.exits.push(String(code ?? ""));
    throw new Error(`process.exit(${code ?? ""}) из кода бота — ${o.exitHint ?? "код бота в процессе харнеса процесс не завершает: ошибка — исключением, выход — внедрённой функцией"}`);
  }) as typeof process.exit;
  try {
    let res: { ok: true; v: T } | { ok: false; error: unknown };
    try { res = { ok: true, v: await fn(w) }; } catch (e) { res = { ok: false, error: e }; }
    await tick(o.tailMs ?? (settled ? 20 : 200));
    return { ...res, rest: takeIssues(ctx) };
  } finally {
    globalThis.fetch = savedFetch;
    process.exit = savedExit;
    s.current = null;
    s.lastId = id;
  }
}

/** Вердикт проверки с проблемами окна, не забранными через settle(): есть хоть одна → RED, ✗-пункты впереди detail */
export function withGuard(v: Verdict, rest: readonly GuardItem[]): Verdict {
  const bad = rest.filter((i) => !i.ok);
  if (!bad.length) return v;
  return { pass: false, detail: `${bad.map((i) => `✗ ${i.name}: ${i.text}`).join(" | ")} || ${v.pass ? "без этого проверка прошла бы: " : ""}${v.detail}` };
}
