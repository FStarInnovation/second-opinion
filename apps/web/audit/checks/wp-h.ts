/**
 * WP-H (apps/web) — ассистент: разбор реплик, валидация тела, бюджет, дайджест, шаблоны гейта.
 * Проверки по docs/AUDIT_PLAN_2026-10-09.md §WP-H (+ поправки оркестратора раунда 3). Каждая не-guard проверка
 * утверждает ЖЕЛАЕМОЕ поведение; до правки продукта — RED. Guard (H.8) — инварианты, GREEN уже сейчас.
 *
 * Чистые функции (moneyIn / routeByRules / promiseByRules / parsePromise / digestReport) импортируются напрямую.
 * Серверные модули (gate.ts, budget.ts, usage-log.ts, app/api/chat/route.ts, app/api/health/route.ts) тянут lib/engine.ts
 * с `import "server-only"`, который вне Next не резолвится, — поэтому они грузятся динамически после регистрации
 * resolve-хука, подменяющего "server-only" пустым модулем (node:module.register, только в этом процессе харнеса).
 *
 * Сеть не нужна: Jev в H.3/H.7/H.7-health — подменённый globalThis.fetch (мок возвращает usage.cost на каждый вызов);
 * /api/chat в H.5 и H.7 и /api/health в H.7-health вызываются как функции POST(Request)/GET() без сервера; LLM-ключи сняты,
 * поэтому provider()="mock"; где Jev не нужен — JEV_ENABLED=0 и fetch-«заглушка», бросающая исключение (страховка от сети).
 * budget.ts и usage-log.ts фиксируют каталог .usage при ПЕРВОМ импорте — поэтому SO_USAGE_DIR указывает на временный
 * каталог харнеса до первого импорта (общий для H.5/H.7/H.7-health), а sentinel-файл подтверждает, что читается именно он.
 * Списание в бюджет измеряется там, где оно происходит (дельта budget.json после /api/chat или /api/health),
 * а не по полям cost в результате гейта — те только в detail.
 *
 * Id с суффиксом (H.2-template, H.7-price, H.7-health) — части пунктов «Изменение» WP-H без собственного номера приёмки
 * (соглашение суффиксов, как R.6-web / R.8-guard); H.8 (guard) допущен поправкой оркестратора (1).
 * H.3: число периодов n (месяц 12, квартал 4, неделя 52, день 365) — конвенция плана по поправке оркестратора (2);
 * альтернативы (365/7 недель, 360 дней) показываются в detail, но не принимаются.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import type { BondReportT } from "@so/engine/contract";
import { getSession, setResult, type ChatSession } from "../../lib/session";
import { type Check, type Verdict, pass, fail, approx, readSrc, readJson, fixture } from "../lib";
import { moneyIn, routeByRules, promiseByRules, parsePromise, numbersIn, jevThreshold } from "../../lib/jev";
import { digestReport } from "../../lib/digest";

type ReportFixture = { kind: "report"; report: BondReportT };
type GateMod = typeof import("../../lib/gate");
type BudgetMod = typeof import("../../lib/budget");
type UsageMod = typeof import("../../lib/usage-log");
type RouteMod = typeof import("../../app/api/chat/route");
type HealthMod = typeof import("../../app/api/health/route");
type Writer = Parameters<GateMod["runGate"]>[0];

const show = (v: unknown) => JSON.stringify(v);
const r9 = (x: number) => Math.round(x * 1e9) / 1e9;
/** Эффективная аннуализация ставки v% за период при n периодах в году: (1+v/100)^n − 1, в % */
const effective = (v: number, n: number) => Math.round((Math.pow(1 + v / 100, n) - 1) * 100 * 1e4) / 1e4;

/* ───── окружение: временно переопределить env / fetch и вернуть обратно ───── */
async function withEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const noNetwork = (async (url: unknown) => { throw new Error(`аудит: сеть запрещена (fetch ${String(url).slice(0, 80)})`); }) as typeof fetch;

/* ───── временный каталог .usage харнеса (один на процесс; budget.ts/usage-log.ts фиксируют DIR при первом импорте) ───── */
let usageDirPath: string | null = null;
function usageDir(): string {
  if (usageDirPath) return usageDirPath;
  usageDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "so-audit-h-usage-"));
  const dir = usageDirPath;
  process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

/* ───── серверные модули: хук "server-only" → пустой модуль, затем динамический импорт с SO_USAGE_DIR харнеса ───── */
let hooked = false;
function ensureHook() {
  if (hooked) return;
  const hook = `export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
  return next(specifier, context);
}`;
  register("data:text/javascript," + encodeURIComponent(hook));
  hooked = true;
}
/** SO_DAILY_BUDGET_USD фиксируется budget.ts при импорте — задаём явно, чтобы окружение разработчика не исчерпало бюджет sentinel'ом */
const SERVER_ENV = () => ({ SO_USAGE_DIR: usageDir(), SO_USAGE_LOG: "0", SO_QUIET: "1", SO_DAILY_BUDGET_USD: "2" });
async function loadGate(): Promise<GateMod> { ensureHook(); return withEnv(SERVER_ENV(), () => import("../../lib/gate")); }
async function loadServer(): Promise<{ gate: GateMod; budget: BudgetMod; usage: UsageMod; route: RouteMod }> {
  ensureHook();
  return withEnv(SERVER_ENV(), async () => {
    const budget = await import("../../lib/budget");
    const usage = await import("../../lib/usage-log");
    const gate = await import("../../lib/gate");
    const route = await import("../../app/api/chat/route");
    return { gate, budget, usage, route };
  });
}
async function loadHealth(): Promise<HealthMod> { ensureHook(); return withEnv(SERVER_ENV(), () => import("../../app/api/health/route")); }
/** Sentinel: записать известное состояние бюджета в каталог харнеса и убедиться, что budget.ts читает именно его */
const SENTINEL = { spent: 0.123456, messages: 7 };
function primeBudget(budget: BudgetMod): { spent: number; messages: number } {
  fs.mkdirSync(usageDir(), { recursive: true });
  fs.writeFileSync(path.join(usageDir(), "budget.json"), JSON.stringify({ day: budget.mskDay(), ...SENTINEL }));
  const st = budget.budgetState();
  if (st.spent !== SENTINEL.spent || st.messages !== SENTINEL.messages)
    throw new Error(`дефект харнеса: budget.ts читает не SO_USAGE_DIR=${usageDir()} (budgetState=${show(st)}, ожидался sentinel ${show(SENTINEL)}) — модуль импортирован раньше с другим каталогом`);
  if (st.exhausted)
    throw new Error(`дефект харнеса: бюджет исчерпан уже sentinel'ом (limit=${st.limit}) — маршрут ответит без гейта, замер списания невозможен`);
  return { spent: st.spent, messages: st.messages };
}

/* ───── мок Jev ─────
 * usage мока: input_tokens=MOCK_IN и cost=COST, причём COST = estimateCost("jev", MOCK_IN) по прайсу usage-log.ts (0,042 $/1M):
 * списание «по cost провайдера» и «по прайсу от токенов» дают ОДНУ дельту — форма правки не влияет на вердикт.
 * Ответ по вопросам запроса (intent / mentions_security / kind); уверенность ≥ порога гейта (jevThreshold), чтобы JEV_THRESHOLD
 * из окружения разработчика не сделал гейт «неуверенным». seen — метка каждого вызова по заданным вопросам: "route" (intent),
 * "kind" (вопрос kind: parsePromise или /api/health), "route+kind" если продукт объединит их в один запрос; иначе — имена вопросов. */
const MOCK_IN = 1000;
const COST = 0.000042; // $, = 1000 × 0.042 / 1e6
function jevMock(cost: number, kindAnswer: string) {
  const seen: string[] = [];
  const conf = Math.min(1, Math.max(0.95, jevThreshold() + 0.01));
  const choice = (c: string, p: number) => ({ type: "choice", choice: c, confidence: p, probabilities: { [c]: p } });
  const f = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, unknown> };
    const q = body.questions ?? {};
    const answers: Record<string, unknown> = {};
    if (q.intent) answers.intent = choice("set_promised", conf);
    if (q.mentions_security) answers.mentions_security = { type: "noul", noul: 0.1 };
    if (q.kind) answers.kind = choice(kindAnswer, conf);
    seen.push([q.intent && "route", q.kind && "kind"].filter(Boolean).join("+") || Object.keys(q).join("+") || "?");
    return new Response(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: MOCK_IN, output_tokens: 0, cost } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, seen };
}
/** Jev «включён» для правил выбора провайдера, ключ фиктивный — уходит только в подменённый fetch; LLM-ключей нет → provider()="mock" */
const JEV_ENV = (): Record<string, string | undefined> => ({
  JEV_ENABLED: undefined, MOCK_LLM: undefined, JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "audit-fake-key",
  OPENROUTER_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, LLM_PROVIDER: undefined, ...SERVER_ENV(),
});

const mkSession = (fx: ReportFixture, id = "audit-h"): ChatSession => ({
  id, query: fx.report.security.isin ?? fx.report.security.secid, result: fx,
  userMessages: 0, usage: { input: 0, output: 0, cost: 0, calls: 0, jev: 0 }, touched: Date.now(),
});
const mkWriter = (parts: Array<Record<string, unknown>>): Writer =>
  ({ write: (p: Record<string, unknown>) => { parts.push(p); }, merge: () => {} }) as unknown as Writer;
const toolInputsOf = (parts: Array<Record<string, unknown>>) =>
  parts.filter((p) => p.type === "tool-input-available").map((p) => ({ tool: p.toolName, input: p.input }));
const textOf = (parts: Array<Record<string, unknown>>) =>
  parts.filter((p) => p.type === "text-delta").map((p) => String(p.delta ?? "")).join("");
const reportInputs = (s: ChatSession) => (s.result?.kind === "report" ? s.result.report.inputs : null);

/* ───── обход объекта: пути и значения ───── */
type Entry = [string, unknown];
function walk(v: unknown, p: string, out: Entry[]) {
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, p ? `${p}.${k}` : k, out);
  else out.push([p, v]);
}
const entriesOf = (v: unknown): Entry[] => { const e: Entry[] = []; walk(v, "", e); return e; };
const strOf = ([p, v]: Entry) => p + " " + (typeof v === "string" ? v : "");
const truthy = (v: unknown) => !(v === false || v === null || v === undefined || v === 0 || v === "");
/** Ссылка на позицию: латинское position*, русские «позиция», «сумма вложения/позиции», «вложен…» */
const POS_RE = /position|позици|сумм[аы]?\s+(?:вложен|позиц)|вложен/i;
const DEF_RE = /по умолчанию|default/i;
/** Отрицание дефолта («задана пользователем, не по умолчанию», not default, non-default) — маркером не считается */
const DEF_NEG_RE = /не\s+по умолчанию|not[\s-]+default|non[\s-]?default/i;
const isDefault = (s: string) => DEF_RE.test(s) && !DEF_NEG_RE.test(s);
/**
 * Маркеры «позиция по умолчанию» в дайджесте:
 *  (a) запись (путь + строковое значение), где упомянута позиция И «по умолчанию»/default без отрицания, значение truthy
 *      — ловит position_size_default:true, inputs_defaults:["position_size"], position_size_source:"default",
 *        "500 000 ₽ (по умолчанию)", note:"позиция не задана — расчёт на сумму по умолчанию", inputs_note:"сумма вложения … по умолчанию";
 *  (b) inputs.position_size === null (позиция не отдана как число) при наличии где-то в дайджесте текста/ключа «по умолчанию»/default.
 * Сравнение двух дайджестов (plain vs p26) делает H.6: маркер засчитывается только если его нет в другом дайджесте по тому же пути
 * с тем же значением — общий словарь вроде defaults:{position_size:500000} в обоих дайджестах маркером не считается.
 */
export function defaultMarkers(digest: unknown): Entry[] {
  const es = entriesOf(digest);
  const anyDefault = es.some((e) => isDefault(strOf(e)));
  return es.filter((e) =>
    (POS_RE.test(strOf(e)) && isDefault(strOf(e)) && truthy(e[1])) ||
    (/(^|\.)position_size$/.test(e[0]) && e[1] === null && anyDefault));
}
const sameIn = (es: Entry[], [p, v]: Entry) => es.some(([q, w]) => q === p && show(w) === show(v));
/** Сумма всех числовых полей `cost` в объекте (decision.usage.cost и любые новые поля учёта) — только для detail */
function sumCosts(v: unknown): number {
  return entriesOf(v).filter(([p, x]) => /(^|\.)cost$/.test(p) && typeof x === "number" && Number.isFinite(x)).reduce((a, [, x]) => a + (x as number), 0);
}

/* ───── статика (только где поведение нельзя вызвать): вырезать комментарии с учётом строковых литералов ───── */
/** Убирает // и /* *\/ вне строк ('…', "…", `…`); # не комментарий в TS; regex-литералы вида /a\/\/b/ не трогает, /[/]/ или кавычка внутри regex-литерала может сбить */
export function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? src.length : j + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
/** Все вызовы fn(...) в исходнике и сколько из них сразу после сбалансированной «)» имеют литеральный фоллбэк `?? 0` (0, 0.0, 00) */
function zeroFallbackCalls(src: string, fn: string): { calls: number; zero: number } {
  let calls = 0, zero = 0;
  for (const m of src.matchAll(new RegExp(fn + "\\s*\\(", "g"))) {
    calls++;
    let i = (m.index ?? 0) + m[0].length, depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; i++; }
    if (/^\s*\?\?\s*0+(?:\.0+)?(?![\d.])/.test(src.slice(i, i + 40))) zero++;
  }
  return { calls, zero };
}

/* ═══════════════ проверки ═══════════════ */

const H1: Check = {
  id: "H.1", wp: "H", kind: "unit",
  title: "moneyIn: слово без числа — не сумма («посмотри», «так», «как» → null), числа с единицей — сумма",
  run(): Verdict {
    const nulls = ["хочу вложить в Самолет, посмотри", "так", "как в прошлый раз"];
    const sums: Array<[string, number]> = [["вложу 2 млн", 2_000_000], ["сумма 500 тысяч", 500_000], ["300к", 300_000]];
    const got0 = nulls.map((s) => [s, moneyIn(s)] as const);
    const got1 = sums.map(([s, e]) => [s, moneyIn(s), e] as const);
    const ok0 = got0.every(([, v]) => v === null);
    const ok1 = got1.every(([, v, e]) => v === e);
    const detail =
      `без суммы → ожидается null: ${got0.map(([s, v]) => `"${s}"→${show(v)}`).join("; ")}` +
      ` | с суммой: ${got1.map(([s, v, e]) => `"${s}"→${show(v)} (ожид. ${e})`).join("; ")}`;
    return ok0 && ok1 ? pass(detail) : fail(detail);
  },
};

const H2: Check = {
  id: "H.2", wp: "H", kind: "fixture",
  title: "Гейт set_commission: «на 1 млн комиссия 0,3» → k_pct=0,3 и position_size=1 000 000 в одной реплике",
  async run(): Promise<Verdict> {
    const text = "на 1 млн комиссия 0,3";
    const fx = fixture<ReportFixture>("live_rolf_plain.json");
    const base = { ...fx.report.inputs };
    if (base.k_pct != null || base.position_size === 1_000_000)
      return fail(`фикстура live_rolf_plain непригодна как база: inputs=${show(base)} (нужны k_pct=null, position_size≠1e6)`);
    const route = routeByRules(text, true);
    const nums = numbersIn(text);
    const parts: Array<Record<string, unknown>> = [];
    const session = mkSession(fx);
    const gate = await loadGate();
    const out = await withFetch(noNetwork, () => withEnv({ JEV_ENABLED: "0" }, () => gate.runGate(mkWriter(parts), session, text, null)));
    const inputs = reportInputs(session);
    const okRoute = route.intent === "set_commission";
    const okK = inputs?.k_pct === 0.3;
    const okPos = inputs?.position_size === 1_000_000;
    const detail =
      `routeByRules→${route.intent} (${route.confidence}); numbersIn=${show(nums)}; база inputs=${show(base)}; ` +
      `после runGate: handled=${out.handled}, inputs=${show(inputs)} (ожид. k_pct=0.3, position_size=1000000); set_inputs=${show(toolInputsOf(parts))}`;
    return okRoute && out.handled && okK && okPos ? pass(detail) : fail(detail);
  },
};

/**
 * Ложное сообщение о пересчёте: в ОДНОМ предложении (разделители . ! ? … ;) «сравнени…» и «обновил…» без отрицания
 * (не / нет / невозможно / нельзя / не с чем) и без отсылки в будущее («сравнение появится/будет, когда назовёте цену»).
 * «Сравнение … невозможно — доходность не рассчитана, Truth Score обновился» — не ложное.
 */
const NEG_RE = /(^|[^а-я])(не|нет|невозможн[а-я]*|нельзя)([^а-я]|$)|не с чем|появ[а-я]+|будет|стан(ет|ут)/i;
function falseUpdateIn(text: string): string | null {
  for (const s of text.split(/(?<=[.!?…;])\s+/)) if (/сравнени[ея]/i.test(s) && /обновил/i.test(s) && !NEG_RE.test(s)) return s;
  return null;
}
const NOT_CALC_RE = /не рассчит|нет (биржевой )?цены|не торгуется|бессрочн|структурн|сравнить не с чем|сравнивать не с чем/i;
const H2T: Check = {
  id: "H.2-template", wp: "H", kind: "fixture",
  title: "Шаблоны гейта — по статусу отчёта: при yield.kind=not_calculated (нет цены / не торгуется / бессрочная / структурная) ответ на «обещали 26%» не утверждает, что сравнение с расчётной доходностью обновилось (либо гейт передаёт реплику модели)",
  async run(): Promise<Verdict> {
    const names = ["cherk1p6", "not_traded", "perpetual", "structured"];
    const gate = await loadGate();
    const rows: Array<{ n: string; status: string; yk: string; handled: boolean | null; ok: boolean; note: string }> = [];
    for (const n of names) {
      const fx = readJson<{ kind: string; report?: BondReportT }>(`packages/engine/golden/expected/${n}.json`);
      if (fx.kind !== "report" || !fx.report || fx.report.yield.kind !== "not_calculated") {
        rows.push({ n, status: String((fx as { report?: BondReportT }).report?.status.kind), yk: String(fx.report?.yield.kind), handled: null, ok: false, note: "эталон непригоден: ожидался report с yield.kind=not_calculated" });
        continue;
      }
      const parts: Array<Record<string, unknown>> = [];
      const session = mkSession(fx as ReportFixture, `audit-h2t-${n}`);
      const out = await withFetch(noNetwork, () => withEnv({ JEV_ENABLED: "0" }, () => gate.runGate(mkWriter(parts), session, "обещали 26%", null)));
      const text = textOf(parts).replace(/\s+/g, " ").trim();
      const falseUpdate = falseUpdateIn(text);
      const ok = !out.handled || falseUpdate == null;
      rows.push({
        n, status: fx.report.status.kind, yk: fx.report.yield.kind, handled: out.handled, ok,
        note: `intent=${out.decision?.intent}, promised_pct→${show(reportInputs(session)?.promised_pct)}, ложное «сравнение…обновилось»=${falseUpdate != null}, упоминает нерасчёт=${NOT_CALC_RE.test(text)}; текст: «${text.slice(0, 120)}»`,
      });
    }
    const bad = rows.filter((r) => !r.ok);
    const detail = `${rows.length - bad.length}/${rows.length} ок (желаемый текст план не фиксирует — утверждается только отсутствие ложного сообщения о пересчёте: «сравнени…» и «обновил…» в одном предложении без отрицания и без отсылки в будущее; pass() в модель тоже принимается) | ` +
      rows.map((r) => `${r.n} [status=${r.status}, yield=${r.yk}, handled=${show(r.handled)}] ${r.ok ? "ок" : "НЕ ок"}: ${r.note}`).join(" | ");
    return bad.length === 0 ? pass(detail) : fail(detail);
  },
};

const H3: Check = {
  id: "H.3", wp: "H", kind: "unit",
  title: "Ставка за период: словарь периодов (месяц/неделя/квартал/день) → per_period, аннуализация эффективная (1+v/100)^n−1 при n = 12 / 52 / 4 / 365 (конвенция плана, поправка 2); per_period без периода → annualized=null (переспросить)",
  async run(): Promise<Verdict> {
    // Блок 1 — правила: весь словарь периодов из плана (каждый месяц|ежемесяч|в неделю|еженедель|ежекварталь|в день) + уже распознаваемые «в месяц», «за квартал».
    // n по плану (поправка оркестратора 2): месяц 12, квартал 4, неделя 52, день 365; альтернативы 365/7 и 360 показаны в detail, но не принимаются.
    const cases: Array<[string, number, number, string]> = [
      ["обещали 2% каждый месяц", 2, 12, "месяц"],
      ["2% в месяц", 2, 12, "месяц"],
      ["ежемесячно 1,5%", 1.5, 12, "месяц"],
      ["5% за квартал", 5, 4, "квартал"],
      ["ежеквартально 4%", 4, 4, "квартал"],
      ["1% в неделю", 1, 52, "неделя"],
      ["еженедельно 0,5%", 0.5, 52, "неделя"],
      ["0,1% в день", 0.1, 365, "день"],
    ];
    const rows = cases.map(([s, v, n, period]) => {
      const d = promiseByRules(s);
      const want = effective(v, n);
      const alt = period === "неделя" ? ` (365/7 недель дало бы ${effective(v, 365 / 7).toFixed(2)} — не по плану)` : period === "день" ? ` (360 дней дало бы ${effective(v, 360).toFixed(2)} — не по плану)` : "";
      const ok = d.kind === "per_period" && approx(d.annualized, want, 0.05);
      return { s, kind: d.kind, annualized: d.annualized, want, n, alt, ok };
    });
    const bad = rows.filter((r) => !r.ok);
    const rulesDetail = `правила (эффективная, n: месяц 12 / квартал 4 / неделя 52 / день 365, tol 0.05 п.п.): ${rows.length - bad.length}/${rows.length} ок` +
      (bad.length ? `; не так: ${bad.map((r) => `"${r.s}"→${r.kind}/${show(r.annualized)} (ожид. per_period/${r.want.toFixed(2)} при n=${r.n}${r.alt})`).join("; ")}` : "");

    // Блок 2 — Jev говорит per_period, но период в тексте не распознан: аннуализировать нечем → annualized=null (гейт переспросит), не v «как годовые»
    const text = "обещали 2% за период";
    const rules = promiseByRules(text);
    const mock = jevMock(COST, "per_period");
    const jev = await withFetch(mock.fetch, () => withEnv(JEV_ENV(), () => parsePromise(text)));
    const okJev = jev.source === "jev" && jev.kind === "per_period" && jev.annualized == null;
    const jevDetail = `Jev=per_period без периода: "${text}" → правила ${rules.kind}/${show(rules.annualized)}; parsePromise(source=${jev.source}, kind=${jev.kind}) annualized=${show(jev.annualized)} (ожид. null); мок-вызовов ${mock.seen.length}`;

    const detail = `${rulesDetail} | ${jevDetail}`;
    return bad.length === 0 && okJev ? pass(detail) : fail(detail);
  },
};

const H4: Check = {
  id: "H.4", wp: "H", kind: "unit",
  title: "routeByRules: «Акционерного общества … 1Р07» — бумага, не out_of_scope; «покажи отчёт» — не out_of_scope",
  run(): Verdict {
    const a = routeByRules("облигации Акционерного общества РОЛЬФ 1Р07", false);
    const b = routeByRules("покажи отчёт", true);
    const okA = a.intent === "check_security";
    const okB = b.intent !== "out_of_scope";
    const detail =
      `«облигации Акционерного общества РОЛЬФ 1Р07» (hasReport=false)→${a.intent} (${a.confidence}, mentions=${a.mentionsSecurity}) — ожид. check_security; ` +
      `«покажи отчёт» (hasReport=true)→${b.intent} (${b.confidence}) — ожид. не out_of_scope`;
    return okA && okB ? pass(detail) : fail(detail);
  },
};

/** Вызов POST /api/chat как функции (без сервера): статус и начало тела; тело читается до конца — execute() завершён; исключение до ответа — status=null */
async function postChat(route: RouteMod, body: unknown): Promise<{ status: number | null; text: string }> {
  try {
    const res = await route.POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const text = await res.text().catch((e: unknown) => `<тело не прочитано: ${String(e)}>`);
    return { status: res.status, text: text.replace(/\s+/g, " ").trim().slice(0, 110) };
  } catch (e) {
    return { status: null, text: `исключение до ответа (в Next — 500): ${String(e instanceof Error ? `${e.name}: ${e.message}` : e).slice(0, 110)}` };
  }
}
const userMsg = (text: string) => ({ id: "m1", role: "user", parts: [{ type: "text", text }] });

const H5: Check = {
  id: "H.5", wp: "H", kind: "unit",
  title: "/api/chat: невалидное тело (сообщение без parts; messages не массив) → 400, лимит сессии и дневной счётчик не тратятся; валидное тело с лишними полями → 200",
  async run(): Promise<Verdict> {
    // Диагностика исходника — только для detail, вердикт динамический
    const src = readSrc("apps/web/app/api/chat/route.ts");
    const diag = `исходник: import zod=${/from\s+["']zod["']/.test(src)}, ` +
      `${src.match(/(?<!JSON)\.(safeParse|parse)\s*\(/)?.[1] ?? "safeParse/parse нет"}, status:400=${/status:\s*400/.test(src)}`;

    const { budget, route } = await loadServer();
    const start = primeBudget(budget); // messages=7
    const A = { id: "audit-h5-a", messages: [{ role: "user" }] };                         // сообщение без parts
    const B = { id: "audit-h5-b", messages: "oops" };                                      // messages не массив
    const C = {                                                                             // валидное: лишние поля клиента (passthrough)
      id: "audit-h5-c", trigger: "submit-message", messageId: "m1",
      messages: [{ ...userMsg("привет"), metadata: { client: "audit" } }],
    };
    const env = { MOCK_LLM: "1", JEV_ENABLED: "0", LLM_PROVIDER: undefined, OPENROUTER_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, TYPESAFE_API_KEY: undefined, ...SERVER_ENV() };
    const r = await withFetch(noNetwork, () => withEnv(env, async () => {
      const a = await postChat(route, A);
      const msgA = budget.budgetState().messages;
      const b = await postChat(route, B);
      const msgB = budget.budgetState().messages;
      const c = await postChat(route, C);
      const msgC = budget.budgetState().messages;
      return { a, b, c, msgA, msgB, msgC };
    }));
    const sess = { a: getSession(A.id).userMessages, b: getSession(B.id).userMessages, c: getSession(C.id).userMessages };

    const okA = r.a.status === 400 && r.msgA === start.messages && sess.a === 0;
    const okB = r.b.status === 400 && r.msgB === start.messages && sess.b === 0;
    const okC = r.c.status === 200 && r.msgC === r.msgB + 1 && sess.c === 1; // валидное сообщение считается ровно один раз
    const detail =
      `A (без parts): status=${show(r.a.status)} (ожид. 400), budget.messages ${start.messages}→${r.msgA} (ожид. без изменений), session.userMessages=${sess.a} (ожид. 0) — ${r.a.text} | ` +
      `B (messages:"oops"): status=${show(r.b.status)} (ожид. 400), budget.messages →${r.msgB} (ожид. ${start.messages}), session.userMessages=${sess.b} (ожид. 0) — ${r.b.text} | ` +
      `C (валидное + лишние поля): status=${show(r.c.status)} (ожид. 200), budget.messages ${r.msgB}→${r.msgC} (ожид. +1), session.userMessages=${sess.c} (ожид. 1) | ${diag}`;
    return okA && okB && okC ? pass(detail) : fail(detail);
  },
};

const H6: Check = {
  id: "H.6", wp: "H", kind: "fixture",
  title: "digestReport: diagnostics.warnings попадают в дайджест; позиция по умолчанию (500 000) помечена «по умолчанию»/default — маркер есть только в дайджесте с дефолтом, в дайджесте с заданной позицией (2 000 000) его нет",
  run(): Verdict {
    const p26 = fixture<ReportFixture>("live_rolf_p26.json").report;     // position 2 000 000 — задана пользователем
    const plain = fixture<ReportFixture>("live_rolf_plain.json").report; // position 500 000 — значение по умолчанию (CONFIG.positionDefault)
    if (plain.inputs.position_size !== 500_000 || p26.inputs.position_size !== 2_000_000)
      return fail(`фикстуры непригодны: plain.position_size=${plain.inputs.position_size} (ожид. 500000, дефолт), p26.position_size=${p26.inputs.position_size} (ожид. 2000000, задана)`);
    const warn = p26.diagnostics.warnings?.[0] ?? "контроль: свой расчёт не сошёлся с биржевым (синтетика аудита)";
    p26.diagnostics.warnings = [warn];
    const dP26 = digestReport(p26);
    const dPlain = digestReport(plain);
    const okWarn = JSON.stringify(dP26).includes(warn);
    // Маркер считается по diff двух дайджестов: запись должна быть в plain и отсутствовать (или отличаться) по тому же пути в p26
    const ePlain = entriesOf(dPlain), eP26 = entriesOf(dP26);
    const plainOnly = defaultMarkers(dPlain).filter((m) => !sameIn(eP26, m));
    const p26Only = defaultMarkers(dP26).filter((m) => !sameIn(ePlain, m));
    const common = defaultMarkers(dPlain).filter((m) => sameIn(eP26, m));
    const fmt = (es: Entry[]) => (es.length ? es.map(([p, v]) => `${p}=${show(v)}`).join(", ") : "нет");
    const detail =
      `warnings=[${show(warn).slice(0, 90)}…] в дайджесте: ${okWarn}; ` +
      `маркер «позиция по умолчанию» (ключ/текст с position|позици|сумма вложения + «по умолчанию»|default без отрицания, либо inputs.position_size=null при тексте «по умолчанию»): ` +
      `только в plain (position_size=${plain.inputs.position_size}): ${fmt(plainOnly)} (ожид. есть); только в p26 (position_size=${p26.inputs.position_size}, задана): ${fmt(p26Only)} (ожид. нет); ` +
      `одинаково в обоих (не маркер): ${fmt(common)}; digest.inputs(plain)=${show(dPlain.inputs)}`;
    return okWarn && plainOnly.length > 0 && p26Only.length === 0 ? pass(detail) : fail(detail);
  },
};

const H7: Check = {
  id: "H.7", wp: "H", kind: "fixture",
  title: "Бюджет: parsePromise возвращает usage (cost Jev-вызова), и /api/chat списывает в бюджет ВСЕ Jev-вызовы реплики «обещали 26%» (route + promise) — измеряется дельта budget.json после POST, не поля результата гейта",
  async run(): Promise<Verdict> {
    const { gate, budget, usage, route } = await loadServer();
    // (a) parsePromise отдаёт usage.cost (план: «PromiseDecision.usage присутствует») — динамически, форма объявления типа не важна
    const mockP = jevMock(COST, "annual_yield");
    const pr = await withFetch(mockP.fetch, () => withEnv(JEV_ENV(), () => parsePromise("обещали 26%")));
    const prCost = (pr as { usage?: { cost?: unknown } }).usage?.cost;
    const okUsage = pr.source === "jev" && typeof prCost === "number" && Math.abs(prCost - COST) < 1e-12;
    const jevSrc = readSrc("apps/web/lib/jev.ts");
    const iface = jevSrc.match(/(?:interface|type)\s+PromiseDecision\b[\s\S]*?\n\}/)?.[0] ?? "";
    const ifaceHasUsage = /\busage\b/.test(iface);

    // (b) списание там, где оно происходит: POST /api/chat как функция, сессия с отчётом, Jev-мок на оба вопроса; LLM-ключей нет → гейт обрабатывает сам, модель не нужна
    const fx = fixture<ReportFixture>("live_rolf_plain.json");
    const s = getSession("audit-h7");
    setResult(s, fx.report.security.isin ?? fx.report.security.secid, fx);
    const mock = jevMock(COST, "annual_yield");
    const before = primeBudget(budget).spent;
    const r = await withFetch(mock.fetch, () => withEnv(JEV_ENV(), () => postChat(route, { id: "audit-h7", messages: [userMsg("обещали 26%")] })));
    const delta = budget.budgetState().spent - before;
    const calls = mock.seen.length;
    const expected = calls * COST;
    const okCalls = mock.seen.some((x) => /route/.test(x)) && mock.seen.some((x) => /kind/.test(x));
    const okSpent = r.status === 200 && delta >= expected - 1e-12;
    const byPrice = usage.estimateCost("jev", MOCK_IN);
    const priceNote = approx(byPrice, COST, 1e-12) ? "" : ` (ВНИМАНИЕ: прайс jev изменился — estimateCost("jev",${MOCK_IN})=${show(byPrice)} ≠ cost мока ${COST}; списание по прайсу даст другую дельту, обновите COST/MOCK_IN харнеса)`;

    // (c) только для detail: что из стоимости видно в GateOutcome при прямом runGate (поля cost) — вердикт на это не опирается
    const mockG = jevMock(COST, "annual_yield");
    const out = await withFetch(mockG.fetch, () => withEnv(JEV_ENV(), () => gate.runGate(mkWriter([]), mkSession(fx, "audit-h7-gate"), "обещали 26%", null)));
    const detail =
      `(a) parsePromise под моком: source=${pr.source}, usage.cost=${show(prCost)} (ожид. ${COST}); объявление PromiseDecision содержит usage: ${ifaceHasUsage} | ` +
      `(b) POST /api/chat «обещали 26%»: status=${show(r.status)}, Jev-вызовов ${calls} [${mock.seen.join(",")}] по ${COST}$ (= estimateCost("jev",${MOCK_IN})${priceNote}) → ожид. списание ≥ ${r9(expected)}$; ` +
      `списано в budget.json: ${r9(delta)}$ ${okSpent ? "ок" : "МЕНЬШЕ"}; promised_pct→${show(reportInputs(s)?.promised_pct)}, session.userMessages=${s.userMessages}, порог гейта ${jevThreshold()} | ` +
      `(c) справочно: прямой runGate → поля cost в GateOutcome суммарно ${r9(sumCosts(out))}$ при ${mockG.seen.length} вызовах (source=${out.decision?.source}, handled=${out.handled})`;
    return okUsage && okCalls && okSpent ? pass(detail) : fail(detail);
  },
};

const H7P: Check = {
  id: "H.7-price", wp: "H", kind: "unit",
  title: "Бюджет: неизвестная модель — консервативная цена, не 0: estimateCost(«неизвестная», 1000, 500) > 0 или priceFor ≠ null (эквивалент: в route.ts ни один estimateCost(...) не имеет литерального фоллбэка «?? 0»)",
  async run(): Promise<Verdict> {
    const { usage } = await loadServer();
    const unknownModel = "audit-unknown-model-xyz";
    const est = usage.estimateCost(unknownModel, 1000, 500);
    const pf = usage.priceFor(unknownModel);
    const known = usage.estimateCost("jev", 1e6); // справочно: прайс jev за 1M токенов (в вердикт не входит — прайс-лист меняется)
    const okDyn = (typeof est === "number" && Number.isFinite(est) && est > 0) || (pf != null && Number.isFinite(pf.input) && pf.input > 0);
    // Эквивалентная форма правки — консервативный фоллбэк на месте вызова в route.ts (статика без комментариев):
    // распознаётся только отсутствие литерального `?? 0` сразу за сбалансированным estimateCost(...); константу, равную 0, или фоллбэк внутри spend() не распознаёт
    const src = stripComments(readSrc("apps/web/app/api/chat/route.ts"));
    const z = zeroFallbackCalls(src, "estimateCost");
    const okStatic = z.calls > 0 && z.zero === 0;
    const detail =
      `estimateCost("${unknownModel}",1000,500)=${show(est)} (ожид. число > 0), priceFor=${show(pf)}; ` +
      `route.ts: вызовов estimateCost ${z.calls}, с литеральным «?? 0» ${z.zero} (ожид. 0; статика видит только литерал 0/0.0 сразу за вызовом, комментарии вырезаны; Math.max(cost, FLOOR) или фоллбэк внутри spend() не распознаёт); ` +
      `справочно: estimateCost("jev",1e6)=${show(known)}; warning при неизвестной модели не проверяется (план его требует, но форма не задана)`;
    return okDyn || okStatic ? pass(detail) : fail(detail);
  },
};

const H7H: Check = {
  id: "H.7-health", wp: "H", kind: "fixture",
  title: "Бюджет: /api/health не тратит Jev бесплатно — два GET подряд: либо не больше одного Jev-вызова (кэш 1–5 мин), либо списание в бюджет ≥ вызовов × cost",
  async run(): Promise<Verdict> {
    const { budget } = await loadServer();
    const health = await loadHealth();
    const mock = jevMock(COST, "check_security");
    const before = primeBudget(budget).spent;
    const bodies = await withFetch(mock.fetch, () => withEnv(JEV_ENV(), async () => {
      const a = (await (await health.GET()).json()) as { jev?: unknown; budget?: { spent_usd?: number } };
      const b = (await (await health.GET()).json()) as { jev?: unknown; budget?: { spent_usd?: number } };
      return [a, b];
    }));
    const delta = budget.budgetState().spent - before;
    const calls = mock.seen.length;
    const okCache = calls <= 1;
    const okSpend = calls > 0 && delta >= calls * COST - 1e-12;
    const detail =
      `два GET /api/health под Jev-моком: Jev-вызовов ${calls} [${mock.seen.join(",")}] (кэш → ≤1), списано в budget.json ${r9(delta)}$ (списание → ≥ ${r9(calls * COST)}$); ` +
      `ответы jev=${show(bodies[0].jev)} / ${show(bodies[1].jev)}, budget.spent_usd=${show(bodies[1].budget?.spent_usd)}; ` +
      `принимается любой из двух путей плана (кэш 1–5 мин или списание)${calls === 0 ? "; Jev не вызывался вовсе — бесплатных вызовов нет, но проверьте, что jevProvider() в health не отключён случайно" : ""}`;
    return okCache || okSpend ? pass(detail) : fail(detail);
  },
};

const H8: Check = {
  id: "H.8", wp: "H", kind: "unit", guard: true,
  title: "Инварианты правил (держатся сейчас): «обещали 26%» при отчёте → set_promised; суммы с единицей; явный offtopic",
  run(): Verdict {
    const r1 = routeByRules("обещали 26%", true);
    const p1 = promiseByRules("обещали 26%");
    const r2 = routeByRules("привет", false);
    const r3 = routeByRules("акции сбера", false);
    const sums: Array<[string, number]> = [["вложу 2 млн", 2_000_000], ["сумма 500 тысяч", 500_000], ["300к", 300_000]];
    const got = sums.map(([s, e]) => [s, moneyIn(s), e] as const);
    const ok =
      r1.intent === "set_promised" && r1.confidence >= 0.8 &&
      p1.kind === "annual_yield" && p1.annualized === 26 &&
      r2.intent === "out_of_scope" && r3.intent === "out_of_scope" &&
      got.every(([, v, e]) => v === e);
    const detail =
      `«обещали 26%» (hasReport)→${r1.intent} (${r1.confidence}); promiseByRules→${p1.kind}/${p1.annualized}; ` +
      `«привет»→${r2.intent}; «акции сбера»→${r3.intent}; moneyIn: ${got.map(([s, v, e]) => `"${s}"→${show(v)} (ожид. ${e})`).join("; ")}`;
    return ok ? pass(detail) : fail(detail);
  },
};

export const checks: Check[] = [H1, H2, H2T, H3, H4, H5, H6, H7, H7P, H7H, H8];
