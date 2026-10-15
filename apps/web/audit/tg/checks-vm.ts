/**
 * WP-TG, группа «vm» (docs/PLAN_telegram_bot_2026-10-14.md §4.1 `@so/present/report`, §4.4 `render.ts`, §4.7, §6): TG.6, TG.6-tg, TG.G5.
 * Инвариант И3 «один текст отчёта»: всё, что пользователь видит в блоках отчёта и веток, приходит из view-model
 * (`presentReport` / `presentBranch`, строки — `vmStrings`); React (сайт) и Telegram (бот) только раскладывают этот текст.
 *
 * Входы всех трёх проверок — `ssrInputs()` инфраструктуры (record-ssr.ts): 16 golden `packages/engine/golden/expected/*.json`
 * (13 отчётов, pick-cherkizovo, pick-program, notfound), 3 live-фикстуры `apps/web/audit/fixtures/live_*.json` и 2 синтетические
 * ветки err (тексты ошибок из кода сервера и движка) — 21 вход. SSR — ровно как в record-ssr.ts (`renderSsr`): `renderToStaticMarkup`
 * в процессе харнеса, чат = `ReportView compact showInputs={false} askPriceUnavailableNote=…` / `PickView|NotFoundView|ErrView compact`
 * (ToolUIs.tsx:35), страница /check = `ResultApp`. Рендер мемоизирован на процесс: TG.6 и TG.G5 сверяют один и тот же HTML.
 *
 *   TG.6    (unit, RED до шага 3)  — сайт, в обе стороны: (а) VM ⊂ ssrText чата и /check; (б) SSR чата ⊂ VM + закрытый список
 *           исключений, aria-label баров = составу VM; (в) чувствительность — мутанты VM (без пункта worst, без «/ 100», без бара) RED в (б).
 *   TG.6-tg (unit, RED до шага 5)  — Telegram, в обе стороны: (а) строки VM есть в выводе renderTurn (текст без тегов или подписи
 *           кнопок), подписи и значения баров — ещё и счётом вхождений (см. turnShows: иначе рендер без баров прошёл бы, потому что
 *           «9,62%» и «Обещали» повторяются в строках claim/доходности); (б) renderReport/renderBranch минус vmStrings и значения BOT →
 *           остаток только из пробелов и `: , · — / % + −`.
 *   TG.G5   (fixture, guard)        — ssrText текущего рендера ≡ снимку fixtures/tg/ssr_golden.json (записан на шаге 1 с d16c809).
 *
 * Модулей ещё нет (`packages/present/src/{report,copy,entry}.ts`, `apps/bot/src/render.ts`): грузятся только `tryImport` по
 * вычисляемому пути (types.ts), нет модуля → RED «нет модуля …; ожидаемо до шага N». Статических импортов несуществующих модулей
 * нет; сигнатуры — структурные типы types.ts. Исключение в коде VM/рендера → RED с текстом исключения (не ERROR).
 * TG.6 и TG.6-tg выполняют код @so/present и бота в процессе харнеса — под защитой guard.ts (guardRun): unhandledRejection,
 * исключения из таймеров, глобальный fetch и process.exit из этого кода → ✗-пункты проверки, а не падение прогона.
 *
 * `makeVmChecks(loaders)` — те же проверки с другими загрузчиками (самопроверка на эталонных и испорченных модулях вне репозитория);
 * в харнесе `checks = makeVmChecks()` (модули из репозитория).
 */
import path from "node:path";
import { fail, pass, REPO_ROOT, type Check, type Verdict } from "../lib";
import { guardRun, withGuard } from "./guard";
import { brief, collapseWs, diff, htmlFragments, tgPlain, type AriaLabel } from "./normalize";
import { CHAT_ASK_PRICE_NOTE, readSnapshot, renderSsr, selfCheck, SSR_SNAPSHOT, ssrInputs, type SsrEntry, type SsrInput } from "./record-ssr";
import {
  loadAll, loadBot, loadPresent,
  type BranchVM, type BuildResultT, type CopyMod, type EntryMod, type EntryParams, type InlineKeyboard, type Loaded,
  type RenderMod, type ReportMod, type ReportVM, type SectionVM, type TgOp, type UIMessage,
} from "./types";

/* ═══════════════════════════ загрузчики (подменяются в самопроверке) ═══════════════════════════ */

export interface VmLoaders {
  /** @so/present/report (шаг 3): presentReport, presentBranch, vmStrings */
  report(): Promise<Loaded<ReportMod>>;
  /** apps/bot/src/render.ts (шаг 5): renderTurn, renderReport, renderBranch */
  render(): Promise<Loaded<RenderMod>>;
  /** @so/present/copy (шаг 2): BOT */
  copy(): Promise<Loaded<CopyMod>>;
  /** @so/present/entry (шаг 2): chatParams — params кнопки «Открыть на сайте» в renderReport */
  entry(): Promise<Loaded<EntryMod>>;
}
export const REPO_VM_LOADERS: VmLoaders = {
  report: () => loadPresent("report", ["presentReport", "presentBranch", "vmStrings"]),
  render: () => loadBot("render"),
  copy: () => loadPresent("copy", ["BOT"]),
  entry: () => loadPresent("entry", ["chatParams"]),
};

/* ═══════════════════════════ мелочи ═══════════════════════════ */

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n = 160) => { const t = oneLine(s); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const errText = (e: unknown) => cut(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 300);
const q = (s: string | null | undefined, n = 110) => (s == null ? "—" : `«${cut(s, n)}»`);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v);
/** Первые n элементов списка через «; » и «… ещё k» */
const head = (xs: readonly string[], n: number) => xs.slice(0, n).join("; ") + (xs.length > n ? `; … ещё ${xs.length - n}` : "");

/** Подпроверка: имя, итог, пояснение (что ожидалось / что получено) */
interface Sub { name: string; ok: boolean; text: string }
const sub = (name: string, ok: boolean, text: string): Sub => ({ name, ok, text });
/** Итог проверки: сначала проваленные подпроверки (✗ с пояснением), затем прошедшие (✓) */
function verdict(subs: Sub[], tail = ""): Verdict {
  const bad = subs.filter((s) => !s.ok);
  const good = subs.filter((s) => s.ok);
  const lines = [...bad.map((s) => `✗ ${s.name}: ${s.text}`), ...good.map((s) => `✓ ${s.name}${s.text ? ` (${s.text})` : ""}`)];
  const top = bad.length ? `не выполнено подпроверок: ${bad.length} из ${subs.length}: ` : `выполнены все подпроверки (${subs.length}): `;
  return bad.length ? fail(top + lines.join(" | ") + tail) : pass(top + lines.join(" | ") + tail);
}
/** Исключение в коде VM/рендера → RED с текстом (не ERROR): харнес здесь ни при чём */
async function guarded(fn: () => Promise<Verdict>): Promise<Verdict> {
  try {
    return await fn();
  } catch (e) {
    return fail(`исключение: ${errText(e)}${e instanceof Error && e.stack ? ` @ ${cut(e.stack.split("\n").slice(1, 3).join(" "), 200)}` : ""}`);
  }
}
/**
 * То же под защитой процесса харнеса (guard.ts): код @so/present/report и render.ts бота выполняется в процессе харнеса —
 * unhandledRejection, исключения из таймеров, глобальный fetch и process.exit из него дают ✗-пункты этой проверки, а не роняют прогон
 */
async function guardedBot(id: string, fn: () => Promise<Verdict>): Promise<Verdict> {
  const g = await guardRun(id, () => guarded(fn));
  return withGuard(g.ok ? g.v : fail(`исключение: ${errText(g.error)}`), g.rest);
}

/* ═══════════════════════════ SSR (как record-ssr.ts), мемоизирован ═══════════════════════════ */

export interface Rendered {
  input: SsrInput;
  /** HTML чата (ToolUIs.tsx:35) и страницы /check (ResultApp) */
  chatHtml: string;
  pageHtml: string;
  /** ssrText обоих рендеров (§6: теги → пробел, сущности раскодированы, \s+ → " ", плюс aria-label) */
  chat: string;
  page: string;
}
let rendered: Promise<Rendered[]> | null = null;
/** Все 21 вход ssrInputs() в двух рендерах. Один раз на процесс: TG.6 и TG.G5 сверяют один и тот же HTML */
export function renderAll(): Promise<Rendered[]> {
  return (rendered ??= (async () => {
    const out: Rendered[] = [];
    for (const input of ssrInputs()) out.push({ input, ...(await renderSsr(input.result)) });
    return out;
  })());
}

/* ═══════════════════════════ VM ═══════════════════════════ */

type VM = ReportVM | BranchVM;
/** VM входа: отчёт → presentReport(r, {askPriceNote: заметка чата}), ветка → presentBranch(res). Вход клонируется (VM не портит фикстуру).
 *  askPriceNote в vmStrings входить не должна (§4.1: видна только после submit, blocks.tsx:111,128) — в SSR её нет, и (а) это ловит */
function vmOf(rep: ReportMod, res: BuildResultT): VM {
  const c = clone(res);
  return c.kind === "report" ? rep.presentReport(c.report, { askPriceNote: CHAT_ASK_PRICE_NOTE }) : rep.presentBranch(c);
}
/** vmStrings с проверкой формы: массив строк */
function stringsOf(rep: ReportMod, vm: VM): { ok: true; strings: string[] } | { ok: false; why: string } {
  const s: unknown = rep.vmStrings(vm);
  if (!Array.isArray(s)) return { ok: false, why: `vmStrings вернула ${brief(s)}, ожидался массив строк` };
  const bad = s.filter((x) => typeof x !== "string");
  if (bad.length) return { ok: false, why: `vmStrings вернула не только строки: ${brief(bad.slice(0, 3))}` };
  return { ok: true, strings: s as string[] };
}
const reportSections = (vm: VM): SectionVM[] => (!("kind" in vm) && Array.isArray((vm as ReportVM).sections) ? (vm as ReportVM).sections : []);

/* ═══════════════════════════ TG.6 (б): SSR ⊂ VM ═══════════════════════════ */

/**
 * Закрытый список исключений TG.6(б) — ровно §6, таблица, TG.6: только элементы управления, которых в Telegram нет.
 * Фрагмент (или aria-label) проходит как исключение, только если РАВЕН литералу. Расширяет список только оркестратор.
 */
export const TG6_EXCEPTIONS: readonly string[] = [
  // форма AskPrice (blocks.tsx:113-116): label, placeholder (атрибут, во фрагменты не попадает), кнопка
  "По какой цене вам предлагают купить? % от номинала",
  "например, 98,5",
  "Посчитать",
  // pick (branches.tsx): кнопки «Проверить», aria-hidden шапка таблицы, aria-label секции
  "Проверить",
  "Выпуск и ISIN",
  "Рег. номер",
  "Торги",
  "Найденные выпуски",
  // notfound: отключённая кнопка
  "Загрузить документ продавца",
  // плашка: CTA (в Telegram её заменяет кнопка BOT.fullReport)
  "Войти и получить полный отчёт",
];

/** Вырезать подстроки (длинные первыми) — для остатка в detail */
function cutAll(s: string, parts: readonly string[], by = " "): string {
  let rest = s;
  for (const p of [...new Set(parts.map(collapseWs).filter(Boolean))].sort((a, b) => b.length - a.length)) rest = rest.split(p).join(by);
  return rest;
}

/** Состав aria-label баров по секции VM: `${barsCaption}: ${bars.map(b => b.label + " " + b.value).join(", ")}` (ui.tsx:60) */
const barsComposite = (s: SectionVM) =>
  collapseWs(`${s.barsCaption ?? ""}: ${(s.bars ?? []).map((b) => `${b.label} ${b.value}`).join(", ")}`);

export interface SsrInVm { problems: string[]; fragments: number; aria: number; bars: number; exceptions: string[] }
/**
 * TG.6(б) на одном входе: каждый непустой фрагмент HTML чата (части между тегами, сущности раскодированы, пробелы схлопнуты)
 * и каждый aria-label, кроме баров, — подстрока хотя бы одной строки vmStrings либо литерал TG6_EXCEPTIONS; aria-label
 * `[data-chart=yield-bars]` равен составу баров одной из секций VM с bars.
 */
export function ssrInVm(chatHtml: string, vm: VM, strings: readonly string[]): SsrInVm {
  const pool = strings.map(collapseWs).filter(Boolean);
  const inPool = (f: string) => pool.some((s) => s.includes(f));
  const exc = new Set(TG6_EXCEPTIONS.map(collapseWs));
  const usedExc = new Set<string>();
  const problems: string[] = [];
  const { text, aria } = htmlFragments(chatHtml);
  for (const f of text) {
    if (inPool(f)) continue;
    if (exc.has(f)) { usedExc.add(f); continue; }
    problems.push(`фрагмент SSR ${q(f)} не входит ни в одну строку vmStrings и не в списке исключений`);
  }
  const barsAria: AriaLabel[] = [];
  for (const a of aria) {
    if (a.attrs["data-chart"] === "yield-bars") { barsAria.push(a); continue; }
    if (inPool(a.value)) continue;
    if (exc.has(a.value)) { usedExc.add(a.value); continue; }
    problems.push(`aria-label ${q(a.value)} (<${a.tag}>) не входит ни в одну строку vmStrings и не в списке исключений`);
  }
  const withBars = reportSections(vm).filter((s) => Array.isArray(s.bars) && s.bars.length > 0);
  const composites = withBars.map(barsComposite);
  for (const a of barsAria) {
    if (composites.includes(a.value)) continue;
    const pieces = withBars.flatMap((s) => [s.barsCaption ?? "", ...(s.bars ?? []).flatMap((b) => [b.label, b.value])]);
    const rest = collapseWs(cutAll(a.value, pieces));
    problems.push(`aria-label баров ${q(a.value, 200)} ≠ составу баров VM ` +
      (composites.length ? `(${composites.map((c) => q(c, 200)).join(" / ")})` : "(в VM нет секции с bars)") +
      `; остаток после вырезания barsCaption, bars[].label и bars[].value (длинные первыми): ${q(rest, 200)}`);
  }
  return { problems, fragments: text.length, aria: aria.length, bars: barsAria.length, exceptions: [...usedExc] };
}

/* ═══════════════════════════ TG.6 (в): мутанты VM ═══════════════════════════ */

/** Убрать из VM всё, где встречается строка hit: элемент массива (строку или объект, у которого прямое строковое поле содержит hit)
 *  выбросить; строковое поле объекта — обнулить в "". Возвращает число правок */
function prune(v: unknown, hit: (s: string) => boolean): number {
  let n = 0;
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const x = v[i];
      const direct = typeof x === "string" ? hit(x) : isObj(x) && Object.values(x).some((y) => typeof y === "string" && hit(y));
      if (direct) { v.splice(i, 1); n++; } else n += prune(x, hit);
    }
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string") { if (hit(x)) { v[k] = ""; n++; } } else n += prune(x, hit);
    }
  }
  return n;
}
/** Во всех строках VM заменить подстроку на "" (мутант «без «/ 100»») */
function strip(v: unknown, what: string): number {
  let n = 0;
  if (Array.isArray(v)) v.forEach((x, i) => { if (typeof x === "string") { if (x.includes(what)) { v[i] = x.split(what).join(""); n++; } } else n += strip(x, what); });
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (typeof x === "string") { if (x.includes(what)) { v[k] = x.split(what).join(""); n++; } } else n += strip(x, what); }
  return n;
}
interface Mutant { name: string; vm: VM | null; why?: string }
/** Мутанты (в): без каждого пункта worst (по тексту риска из отчёта), без «/ 100», без каждого элемента bars[] */
function mutants(vm: VM, res: BuildResultT, o: { worst: boolean; score: boolean; bars: boolean }): Mutant[] {
  const out: Mutant[] = [];
  if (o.worst) {
    const ws = res.kind === "report" ? res.report.worst : [];
    if (!ws.length) out.push({ name: "без пункта worst", vm: null, why: "в отчёте нет worst" });
    for (const w of ws) {
      const m = clone(vm);
      const t = collapseWs(w.text);
      const n = prune(m, (s) => collapseWs(s).includes(t));
      out.push(n ? { name: `без пункта worst ${q(w.title, 40)}`, vm: m } : { name: `без пункта worst ${q(w.title, 40)}`, vm: null, why: `в VM нет строки с текстом риска ${q(w.text, 80)}` });
    }
  }
  if (o.score) {
    const m = clone(vm);
    const n = strip(m, "/ 100");
    out.push(n ? { name: "без «/ 100»", vm: m } : { name: "без «/ 100»", vm: null, why: "ни одна строка VM не содержит «/ 100»" });
  }
  if (o.bars) {
    const idx = reportSections(vm).findIndex((s) => Array.isArray(s.bars) && s.bars.length > 0);
    if (idx < 0) out.push({ name: "без элемента bars[]", vm: null, why: "в VM нет секции с bars" });
    else {
      const bars = reportSections(vm)[idx].bars ?? [];
      bars.forEach((b, i) => {
        const m = clone(vm);
        reportSections(m)[idx].bars?.splice(i, 1);
        out.push({ name: `без bars[${i}] ${q(`${b.label} ${b.value}`, 50)}`, vm: m });
      });
    }
  }
  return out;
}

/* ═══════════════════════════ Telegram ═══════════════════════════ */

const CABINET = "https://vfo.autremus.com"; // CABINET_HREF §4.1 — значение нужно только как опция рендера
const SITE = "https://so.example.ru";       // SO_SITE_URL: с ним renderReport даёт и кнопку «Открыть на сайте»
/** Подписи кнопок клавиатуры */
const buttonTexts = (kb: InlineKeyboard | undefined): string[] =>
  (kb?.inline_keyboard ?? []).flat().map((b) => (typeof b?.text === "string" ? b.text : ""));
/** Сообщение ассистента, как его собрал ai: step-start, tool-part output-available {query, result}, step-start, текст */
function toolMessage(id: string, toolName: string, query: string, result: BuildResultT): UIMessage {
  return {
    id: `vm-${id}`, role: "assistant",
    parts: [
      { type: "step-start" },
      { type: `tool-${toolName}`, toolCallId: `call_vm_${id}`, state: "output-available", input: { query }, output: { query, result } },
      { type: "step-start" },
      { type: "text", text: "Готово.", state: "done" },
    ],
  } as unknown as UIMessage;
}
/** Разрешённый остаток TG.6-tg(б): пробелы и знаки `: , · — / % + −` (без букв и цифр) */
const REST_OK = /^[\s:,·—\/%+−]*$/u;
/** BOT: только строковые значения (dailyLimit/notAllowed — функции, к отчёту не относятся) */
const botStrings = (bot: unknown): string[] => (isObj(bot) ? Object.values(bot).filter((v): v is string => typeof v === "string") : []);

/** Число непересекающихся вхождений подстроки (жадно слева — это и максимум) */
const occ = (t: string, s: string) => (s ? t.split(s).length - 1 : 0);

/**
 * TG.6-tg(а) на одном входе: renderTurn(сообщение с tool-part {query, result}) — каждая строка VM есть в тексте сообщения
 * (HTML: tgPlain — теги на "", сущности раскодированы; простой текст как есть) или в подписи кнопки; пробелы схлопнуты с обеих сторон.
 * Бары (§6: «требуется только наличие barsCaption, каждого label и value, формат строки свободный»): значения и подписи баров
 * повторяются в других строках отчёта («9,62%» есть и в строке claim, и в строке доходности), поэтому простое «есть в выводе»
 * пропустило бы рендер без баров. Для bars[].label и bars[].value требуется ещё и счёт: вхождений в выводе не меньше, чем во всех
 * строках vmStrings вместе (у верного рендера каждая строка VM стоит в выводе на своём месте, и счёт сходится при любом формате).
 * barsCaption не считается: он может совпадать с заголовком секции («Доходность»), и рендер вправе не повторять его.
 */
function turnShows(render: RenderMod, name: string, res: BuildResultT, vm: VM, strings: readonly string[]): { problem: string | null; ops: number; btns: number } {
  const query = res.kind === "report" ? (res.report.security.isin ?? res.report.security.secid) : res.query;
  const tool = name.startsWith("live_") || name.startsWith("err-") ? "build_bond_report" : "resolve_security";
  let out: unknown;
  try { out = render.renderTurn(toolMessage(name, tool, query, clone(res)), { siteUrl: SITE, cabinetHref: CABINET }); }
  catch (e) { return { problem: `${name}: renderTurn бросила ${errText(e)}`, ops: 0, btns: 0 }; }
  if (!Array.isArray(out)) return { problem: `${name}: renderTurn вернула ${brief(out)}, ожидался массив TgOp`, ops: 0, btns: 0 };
  const seen: string[] = [];
  let ops = 0, btns = 0;
  for (const o of out as TgOp[]) {
    if (!o || typeof o.text !== "string") continue;
    ops++;
    seen.push(collapseWs(o.html ? tgPlain(o.text) : o.text));
    for (const b of buttonTexts(o.keyboard)) { btns++; seen.push(collapseWs(b)); }
  }
  const pool = strings.map(collapseWs).filter(Boolean);
  const probs: string[] = [];
  const miss = pool.filter((s) => !seen.some((t) => t.includes(s)));
  if (miss.length) probs.push(`строк VM нет ни в тексте, ни на кнопках (${miss.length}): ${miss.slice(0, 3).map((s) => q(s, 80)).join(", ")}`);
  const barBits = [...new Set(reportSections(vm).flatMap((s) => (s.bars ?? []).flatMap((b) => [b.label, b.value])).map(collapseWs).filter(Boolean))];
  const short = barBits.map((s) => ({ s, need: pool.reduce((a, v) => a + occ(v, s), 0), have: seen.reduce((a, t) => a + occ(t, s), 0) })).filter((x) => x.have < x.need);
  if (short.length)
    probs.push(`бары показаны не полностью: ${short.slice(0, 3).map((x) => `${q(x.s, 40)}: вхождений в выводе ${x.have}, в строках VM ${x.need}`).join(", ")}` +
      " (подпись или значение бара найдено только внутри других строк отчёта)");
  if (!probs.length) return { problem: null, ops, btns };
  return { problem: `${name}: ${probs.join("; ")} (сообщений ${ops}: ${q(seen.join(" ‖ "), 140)})`, ops, btns };
}

/* ═══════════════════════════ проверки ═══════════════════════════ */

export function makeVmChecks(L: VmLoaders = REPO_VM_LOADERS): Check[] {
  /* ─────────────── TG.6 ─────────────── */
  const TG6: Check = {
    id: "TG.6", wp: "TG", kind: "unit",
    title: "И3, сайт: строки VM (vmStrings) есть в SSR чата и /check; каждый фрагмент SSR чата — из VM или закрытого списка исключений, aria баров = составу VM; мутанты VM дают RED",
    run: () => guardedBot("TG.6", async () => {
      const rep = await L.report();
      if (!rep.ok) {
        let ssrNote = "";
        try {
          const rs = await renderAll();
          const fr = rs.map((r) => htmlFragments(r.chatHtml));
          ssrNote = ` SSR-сторона готова (входов ${rs.length}, рендеров ${rs.length * 2}; в HTML чата фрагментов ${fr.reduce((a, f) => a + f.text.length, 0)}, ` +
            `aria-label ${fr.reduce((a, f) => a + f.aria.length, 0)}, из них баров ${fr.reduce((a, f) => a + f.aria.filter((x) => x.attrs["data-chart"] === "yield-bars").length, 0)}), сверять не с чем.`;
        } catch (e) { ssrNote = ` (SSR тоже не отрендерился: ${errText(e)})`; }
        return fail(`${rep.detail}: presentReport/presentBranch/vmStrings (§4.1 @so/present/report) ещё не написаны — VM нет, (а), (б), (в) не проверить.${ssrNote}`);
      }
      const R = rep.mod;
      const rs = await renderAll();
      const subs: Sub[] = [];
      const vms = new Map<string, { vm: VM; strings: string[] }>();
      const pre: string[] = [];
      for (const r of rs) {
        let vm: VM;
        try { vm = vmOf(R, r.input.result); } catch (e) { pre.push(`${r.input.name}: ${r.input.result.kind === "report" ? "presentReport" : "presentBranch"} бросила ${errText(e)}`); continue; }
        let st: ReturnType<typeof stringsOf>;
        try { st = stringsOf(R, vm); } catch (e) { pre.push(`${r.input.name}: vmStrings бросила ${errText(e)}`); continue; }
        if (!st.ok) { pre.push(`${r.input.name}: ${st.why}`); continue; }
        vms.set(r.input.name, { vm, strings: st.strings });
      }
      if (pre.length) subs.push(sub(`VM на всех входах (${rs.length})`, false, head(pre, 4)));

      // (а) VM ⊂ SSR: каждая строка vmStrings есть в ssrText чата и страницы /check
      {
        const probs: string[] = [];
        let n = 0;
        for (const r of rs) {
          const v = vms.get(r.input.name);
          if (!v) continue;
          for (const s of v.strings) {
            const t = collapseWs(s);
            if (!t) continue;
            n++;
            const inChat = r.chat.includes(t), inPage = r.page.includes(t);
            if (!inChat || !inPage)
              probs.push(`${r.input.name}: строка VM ${q(t)} не найдена в ssrText ${!inChat && !inPage ? "чата и /check" : !inChat ? "чата (ReportView compact)" : "/check (ResultApp)"}`);
          }
        }
        subs.push(sub("(а) VM ⊂ SSR: каждая строка vmStrings есть в ssrText чата и /check (теги → пробел, плюс aria-label)", !probs.length,
          probs.length ? `строк VM, не видных на сайте: ${probs.length}: ${head(probs, 5)}` : `строк VM ${n}, входов ${vms.size} — все найдены в обоих рендерах`));
      }
      // (б) SSR ⊂ VM: фрагменты HTML чата и aria-label — из VM или закрытого списка; aria баров = составу VM
      const base = new Map<string, SsrInVm>();
      {
        const probs: string[] = [];
        let frags = 0, aria = 0, bars = 0;
        const used = new Set<string>();
        for (const r of rs) {
          const v = vms.get(r.input.name);
          if (!v) continue;
          const res = ssrInVm(r.chatHtml, v.vm, v.strings);
          base.set(r.input.name, res);
          frags += res.fragments; aria += res.aria; bars += res.bars;
          res.exceptions.forEach((x) => used.add(x));
          for (const p of res.problems) probs.push(`${r.input.name}: ${p}`);
        }
        subs.push(sub("(б) SSR чата ⊂ VM: фрагменты и aria-label — подстроки vmStrings или литералы закрытого списка; aria-label баров = `${barsCaption}: ${label value, …}`", !probs.length,
          probs.length ? `нарушений (текст сайта не из VM): ${probs.length}: ${head(probs, 5)}`
            : `фрагментов ${frags}, aria-label ${aria} (из них баров ${bars}), входов ${base.size} — все из VM; сработали исключения: ${[...used].map((x) => q(x, 40)).join(", ") || "нет"}`));
      }
      // (в) чувствительность: мутанты VM дают RED в (б) — новое нарушение, которого нет у исходной VM
      {
        const probs: string[] = [];
        const okNames: string[] = [];
        const plan: [string, { worst: boolean; score: boolean; bars: boolean }][] = [["veb", { worst: true, score: true, bars: true }], ["cherk1p7", { worst: false, score: false, bars: true }]];
        for (const [name, o] of plan) {
          const r = rs.find((x) => x.input.name === name);
          const v = vms.get(name);
          if (!r || !v) { probs.push(`${name}: нет VM входа (см. выше)`); continue; }
          const was = new Set(base.get(name)?.problems ?? []);
          for (const m of mutants(v.vm, r.input.result, o)) {
            if (!m.vm) { probs.push(`${name}, мутант ${m.name}: неприменим — ${m.why}`); continue; }
            let got: string[];
            try {
              const st = stringsOf(R, m.vm);
              if (!st.ok) { probs.push(`${name}, мутант ${m.name}: ${st.why}`); continue; }
              got = ssrInVm(r.chatHtml, m.vm, st.strings).problems.filter((p) => !was.has(p));
            } catch (e) { probs.push(`${name}, мутант ${m.name}: vmStrings бросила ${errText(e)}`); continue; }
            if (!got.length) probs.push(`${name}, мутант ${m.name}: (б) осталась без новых нарушений — сверка SSR ⊂ VM не заметила потерю`);
            else okNames.push(`${name} ${m.name} → ${cut(got[0], 90)}`);
          }
        }
        subs.push(sub("(в) чувствительность: VM без пункта worst, без «/ 100», без одного bars[] → RED в (б)", !probs.length,
          probs.length ? head(probs, 5) : `мутантов поймано: ${okNames.length}: ${head(okNames, 3)}`));
      }
      return verdict(subs, ` · входы: ${rs.length} (16 golden, 3 live, 2 err)`);
    }),
  };

  /* ─────────────── TG.6-tg ─────────────── */
  const TG6tg: Check = {
    id: "TG.6-tg", wp: "TG", kind: "unit",
    title: "И3, Telegram: строки VM есть в выводе renderTurn (текст без тегов или подписи кнопок); renderReport/renderBranch не добавляют своего текста сверх VM и BOT",
    run: () => guardedBot("TG.6-tg", async () => {
      const m = await loadAll({ render: () => L.render(), report: () => L.report(), copy: () => L.copy(), entry: () => L.entry() });
      if (!m.ok) return fail(`${m.detail}: рендера VM в Telegram-HTML (§4.4 render.ts, §4.7) ещё нет — сверять нечего`);
      const { render, report: R, copy, entry } = m.mods;
      const BOT = botStrings(copy.BOT);
      const subs: Sub[] = [];
      const inputs = ssrInputs();
      const pa: string[] = [];
      const pb: string[] = [];
      let strs = 0, ops = 0, btns = 0;
      for (const inp of inputs) {
        const res = inp.result;
        const name = inp.name;
        let vm: VM;
        let strings: string[];
        try {
          vm = vmOf(R, res);
          const st = stringsOf(R, vm);
          if (!st.ok) { pa.push(`${name}: ${st.why}`); continue; }
          strings = st.strings;
        } catch (e) { pa.push(`${name}: VM не построилась: ${errText(e)}`); continue; }

        // (а) каждая строка VM — в тексте сообщений renderTurn (HTML: теги на "", сущности раскодированы) или на кнопках
        strs += strings.length;
        const a = turnShows(render, name, res, vm, strings);
        ops += a.ops; btns += a.btns;
        if (a.problem) pa.push(a.problem);
        // (б) renderReport/renderBranch: текст (теги на "") + подписи кнопок − vmStrings − BOT → только пробелы и `: , · — / % + −`
        {
          let html: unknown, kb: InlineKeyboard | undefined;
          try {
            let r: { html: string; keyboard?: InlineKeyboard };
            if (res.kind === "report") {
              const params: EntryParams | undefined = entry.chatParams(clone(res), res.report.security.isin ?? res.report.security.secid) ?? undefined;
              r = render.renderReport(vm as ReportVM, { siteUrl: SITE, cabinetHref: CABINET, params });
            } else r = render.renderBranch(vm as BranchVM);
            html = r?.html; kb = r?.keyboard;
          } catch (e) { pb.push(`${name}: ${res.kind === "report" ? "renderReport" : "renderBranch"} бросила ${errText(e)}`); continue; }
          if (typeof html !== "string") { pb.push(`${name}: html = ${brief(html)}, ожидалась строка`); continue; }
          const shown = collapseWs([tgPlain(html), ...buttonTexts(kb)].join("\n"));
          const rest = collapseWs(cutAll(shown, [...strings, ...BOT]));
          if (!REST_OK.test(rest)) {
            const bad = [...new Set([...rest].filter((ch) => !REST_OK.test(ch)))].join("");
            pb.push(`${name} (${res.kind === "report" ? "renderReport" : "renderBranch"}): остаток ${q(rest, 160)} — лишние символы ${q(bad, 40)}`);
          }
        }
      }
      subs.push(sub("(а) VM ⊂ Telegram: каждая строка vmStrings есть в тексте сообщений renderTurn (теги сняты на \"\", сущности раскодированы) или в подписях кнопок; подписи и значения баров — не реже, чем в строках VM", !pa.length,
        pa.length ? `входов с пропусками: ${pa.length}: ${head(pa, 4)}` : `строк VM ${strs}, входов ${inputs.length} — все видны; сообщений ${ops}, кнопок ${btns}`));
      subs.push(sub("(б) Telegram ⊂ VM + BOT: текст renderReport/renderBranch и подписи кнопок после вырезания vmStrings и значений BOT (длинные первыми) — только пробелы и `: , · — / % + −`", !pb.length,
        pb.length ? `входов со своим текстом бота: ${pb.length}: ${head(pb, 4)}` : `входов ${inputs.length}, своего текста нет; значений BOT ${BOT.length}`));
      return verdict(subs, ` · входы: ${inputs.length} (16 golden, 3 live, 2 err); siteUrl ${SITE}, cabinetHref ${CABINET}`);
    }),
  };

  /* ─────────────── TG.G5 ─────────────── */
  const G5: Check = {
    id: "TG.G5", wp: "TG", kind: "fixture", guard: true,
    title: "SSR не изменился: ssrText 21 входа (16 golden, 3 live, 2 err) в чате и на /check ≡ снимку fixtures/tg/ssr_golden.json",
    run: () => guarded(async () => {
      const snap = readSnapshot();
      const rel = path.relative(REPO_ROOT, SSR_SNAPSHOT);
      if (!snap) return fail(`нет снимка ${rel}: его пишет шаг 1 (record-ssr.ts --record-tg-ssr с d16c809), дальше меняет только оркестратор`);
      const rs = await renderAll();
      const React = await import("react");
      const probs: string[] = [];
      const names = new Set(rs.map((r) => r.input.name));
      for (const r of rs) {
        const e: SsrEntry | undefined = snap.entries[r.input.name];
        if (!e) { probs.push(`${r.input.name}: вход есть в ssrInputs(), но его нет в снимке`); continue; }
        if (e.kind !== r.input.result.kind) probs.push(`${r.input.name}: kind в снимке ${e.kind}, сейчас ${r.input.result.kind}`);
        for (const view of ["chat", "page"] as const) {
          const d = diff(e[view], r[view], { path: `${r.input.name}.${view}`, labels: ["снимок", "сейчас"] });
          if (d) probs.push(d);
        }
      }
      for (const n of Object.keys(snap.entries)) if (!names.has(n)) probs.push(`${n}: есть в снимке, но нет среди текущих входов ssrInputs()`);
      const sc = selfCheck({ recorded: snap.recorded, entries: Object.fromEntries(rs.map((r) => [r.input.name, { source: r.input.source, kind: r.input.result.kind, chat: r.chat, page: r.page }])) });
      const meta = `снимок: commit ${snap.recorded.commit}, ${snap.recorded.date}, React ${snap.recorded.react}; сейчас React ${React.version}`;
      const subs: Sub[] = [
        sub(`ssrText ≡ снимку (входов ${rs.length}, рендеры чата и /check)`, !probs.length,
          probs.length ? `расхождений со снимком: ${probs.length} (шаг 3 обязан сохранить SSR побайтно; снимок меняет только оркестратор): ${head(probs, 4)}` : `совпали все рендеры (${rs.length * 2})`),
        sub("самопроверка §6: veb содержит «40 / 100», cherk2p2 — «+0,24% за период до колла» (в обоих рендерах)", sc.ok, sc.lines.join("; ")),
      ];
      return verdict(subs, ` · ${meta}`);
    }),
  };

  return [TG6, TG6tg, G5];
}

export const checks: Check[] = makeVmChecks();
