/**
 * WP-TG: таймеры кода бота на время кейса (TG.9, TG.17, TG.18). Ход не оставляет после себя живых таймеров: интервал typing
 * (каждые 4 с, §4.4) и таймер хода (turnTimeoutMs) снимаются, когда ход кончился. Живой интервал typing шлёт sendChatAction
 * после ответа — «печатает…» висит после отчёта; неснятый таймер хода держит процесс и абортит уже завершённый запрос.
 *
 *  - trackBotTimers() подменяет globalThis.setTimeout/setInterval/clearTimeout/clearInterval обёртками. Учитываются только
 *    таймеры, которые поставил код бота: ближайший вызывающий кадр — в /apps/bot/src/. Таймеры харнеса (within(), sleeper,
 *    tick, until — в том числе когда их вызывает внедрённый в ядро sleep) и библиотек не учитываются.
 *  - alive() — неснятые интервалы и несработавшие неснятые таймауты бота (с местом создания);
 *  - spin() — один раз вызвать колбэки живых интервалов бота: «прокрутить» следующий тик typing без реальных 4 с ожидания;
 *  - clearAlive() — снять живые таймеры бота (следующий кейс начинается чистым; мутант не стреляет в чужом окне);
 *  - restore() — clearAlive() и вернуть глобальные функции.
 * typingAfterLast(calls) — сколько sendChatAction в записи FakeTg после последней sendMessage/editMessageText (в том числе упавших).
 * afterTurnIssues(...) — оба условия после core.idle(): нет живых таймеров бота; после «прокрутки» нет typing после ответа.
 */

const BOT_SRC = "/apps/bot/src/";
const tick = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

interface Rec { kind: "setTimeout" | "setInterval"; handle: unknown; cb: (...a: unknown[]) => unknown; args: unknown[]; at: string; done: boolean }

export interface BotTimers {
  alive(): string[];
  spin(): number;
  clearAlive(): void;
  restore(): void;
}

let active = false;

/** Ближайший кадр вызывающего (без самой обёртки fn) */
function callerFrame(fn: (...a: never[]) => unknown): string {
  const o: { stack?: string } = {};
  Error.captureStackTrace(o, fn);
  const line = (o.stack ?? "").split("\n").slice(1).find((l) => l.trim().startsWith("at ")) ?? "";
  return line.trim().replace(/^at\s+/, "");
}
const shortAt = (at: string) => { const i = at.indexOf(BOT_SRC); return i >= 0 ? `${at.slice(0, at.lastIndexOf("(", i) + 1)}${at.slice(i + 1)}` : at; };

export function trackBotTimers(): BotTimers {
  if (active) throw new Error("дефект харнеса: trackBotTimers() внутри trackBotTimers()");
  active = true;
  const g = globalThis as unknown as Record<"setTimeout" | "setInterval" | "clearTimeout" | "clearInterval", (...a: unknown[]) => unknown>;
  const saved = { setTimeout: g.setTimeout, setInterval: g.setInterval, clearTimeout: g.clearTimeout, clearInterval: g.clearInterval };
  const recs: Rec[] = [];
  const isAlive = (r: Rec) => !r.done && !(r.handle as { _destroyed?: boolean } | null)?._destroyed;
  const find = (h: unknown): Rec | undefined => {
    if (h == null) return undefined;
    const direct = recs.find((r) => r.handle === h);
    if (direct || (typeof h !== "number" && typeof h !== "string")) return direct;
    return recs.find((r) => isAlive(r) && Number(r.handle as number) === Number(h));
  };
  const wrapSet = (kind: Rec["kind"]) => {
    const orig = saved[kind];
    const wrapped = function (this: unknown, cb: unknown, ms?: unknown, ...args: unknown[]): unknown {
      const at = callerFrame(wrapped);
      if (typeof cb !== "function" || !at.includes(BOT_SRC)) return orig.call(this, cb, ms, ...args);
      const f = cb as (...a: unknown[]) => unknown;
      const rec: Rec = { kind, handle: null, cb: f, args, at, done: false };
      const run = kind === "setTimeout" ? function (this: unknown, ...a: unknown[]) { rec.done = true; return f.apply(this, a); } : f;
      rec.handle = orig.call(this, run, ms, ...args);
      recs.push(rec);
      return rec.handle;
    };
    // util.promisify(setTimeout) и прочие свойства оригинала
    for (const k of Reflect.ownKeys(orig)) if (!["length", "name", "prototype"].includes(String(k))) { try { Object.defineProperty(wrapped, k, Object.getOwnPropertyDescriptor(orig, k)!); } catch { /* не переносится */ } }
    return wrapped;
  };
  const wrapClear = (kind: "clearTimeout" | "clearInterval") => {
    const orig = saved[kind];
    return function (this: unknown, h?: unknown): unknown {
      const r = find(h);
      if (r) r.done = true;
      return orig.call(this, h);
    };
  };
  g.setTimeout = wrapSet("setTimeout");
  g.setInterval = wrapSet("setInterval");
  g.clearTimeout = wrapClear("clearTimeout");
  g.clearInterval = wrapClear("clearInterval");

  const t: BotTimers = {
    alive: () => recs.filter(isAlive).map((r) => `${r.kind} @ ${shortAt(r.at)}`),
    spin() {
      let n = 0;
      for (const r of recs.filter((x) => x.kind === "setInterval" && isAlive(x))) {
        n++;
        try { const v = r.cb(...r.args); if (v && typeof (v as Promise<unknown>).catch === "function") (v as Promise<unknown>).catch(() => {}); } catch { /* колбэк бота бросил — не дело этой проверки */ }
      }
      return n;
    },
    clearAlive() {
      for (const r of recs.filter(isAlive)) { r.done = true; saved[r.kind === "setTimeout" ? "clearTimeout" : "clearInterval"](r.handle); }
    },
    restore() {
      t.clearAlive();
      Object.assign(g, saved);
      active = false;
    },
  };
  return t;
}

/** Сколько sendChatAction после последней sendMessage/editMessageText (вызовы в порядке записи FakeTg) */
export function typingAfterLast(calls: readonly { method: string }[]): number {
  let last = -1;
  calls.forEach((c, i) => { if (c.method === "sendMessage" || c.method === "editMessageText") last = i; });
  return calls.slice(last + 1).filter((c) => c.method === "sendChatAction").length;
}

/**
 * Оба условия после core.idle(): (1) живых таймеров бота нет; (2) после «прокрутки» оставшихся интервалов (spin) и короткой паузы
 * нет sendChatAction после последнего сообщения хода. Затем живые таймеры бота снимаются. Пусто — всё в порядке.
 */
export async function afterTurnIssues(t: BotTimers, calls: () => readonly { method: string }[]): Promise<string[]> {
  const out: string[] = [];
  const alive = t.alive();
  if (alive.length) out.push(`после хода живы таймеры бота (${alive.length}): ${[...new Set(alive)].slice(0, 3).join("; ")} — typing и таймер хода снимаются, когда ход кончился`);
  t.spin();
  await tick(20);
  const extra = typingAfterLast(calls());
  if (extra) out.push(`после последней sendMessage/editMessageText хода ещё ${extra} sendChatAction (typing пережил ход${alive.length ? `; интервал «прокручен» один раз` : ""})`);
  t.clearAlive();
  return out;
}
