/**
 * WP-U (apps/web, гейт/глоссарий/дайджест) — находки разбора диалогов 12.10.2026 (docs/DIALOGS_REVIEW_2026-10-12.md),
 * проверенные на ТЕКУЩЕМ коде. Каждая проверка утверждает ЖЕЛАЕМОЕ поведение: RED — дефект есть сейчас, GREEN — уже
 * правильно (находка не подтвердилась). Ни одна проверка не подгоняется под цвет — detail показывает входы и факты.
 *
 * Как устроено.
 *  - Чистые функции (findTerm, promiseByRules, parsePromise при JEV_ENABLED=0, digestReport) — прямо в процессе харнеса (U.3–U.5, U.9 часть 1, U.11).
 *  - Гейт (apps/web/lib/gate.ts → lib/engine.ts) тянет `import "server-only"`, а engine.ts читает SO_OFFLINE и держит кэш отчётов
 *    на уровне модуля; jev.ts фиксирует порог и адрес Jev при импорте. Чтобы порядок проверок других WP не влиял на результат
 *    (кэш «тёплый», OFFLINE включён чужим импортом), сценарии гейта гоняются в ДОЧЕРНЕМ процессе на каждую проверку:
 *    `node --import tsx <этот файл> --scenario U.n` (cwd = apps/web), "server-only" → пустой модуль через module.registerHooks.
 *  - Сеть в дочернем процессе: globalThis.fetch подменён целиком.
 *      ISS (https://iss.moex.com/iss/…) → снимок ISS по тому же slug, что в packages/engine/src/iss/client.ts (history — по префиксу,
 *        окно дат зависит от сегодня): golden/snapshots/rolf (RU000A10ASE2), golden/snapshots/ofz26238 (RU000A1038V6),
 *        audit-fixtures/sfo_ast0 (RU000A10AST0, ССекьюр_А, гейт контроля). Это ПРОДОВАЯ ветвь buildCached (SO_OFFLINE снят), а
 *        не офлайн-ветвь: так в U.2 можно сделать сборку медленной (задержка каждого ответа ISS).
 *      Jev (https://api.typesafe.ai/v1/systemone, ключ фиктивный) → мок с заданным ответом сценария; запросы записываются.
 *      Любой другой URL (и ISS без снимка, и Jev, когда сценарий его не ждёт) → исключение, URL попадает в detail.
 *    LLM не вызывается: гейт тестируется напрямую (runGate), handled=false означает «реплика ушла бы модели».
 *  - Порог Jev — значение кода по умолчанию (JEV_THRESHOLD из окружения в дочернем процессе снят); фактический порог — в detail.
 *  - U.11 совместима с D.2/D.5 (apps/web/audit/checks/wp-d.ts): D.2 требует упоминания контроля, Δ расхождения в дайджесте и
 *    факта гейта; предупреждения движка ЦЕЛИКОМ — только без гейта (при сработавшем гейте, после правки WP-U, — не контрольные
 *    целиком, а собственного расчёта own_control_pct в дайджесте нет). U.11 требует того же сигнала (control_failed или
 *    «не сошёлся»), но запрещает в дайджесте собственный расчёт, жаргон «гейт», «сетка комиссий», ярлык «контроль:» и фразу
 *    «…к коллу не рассчитан…» при главной доходности к коллу. Обе зелёные, когда дайджест при гейте заменяет сырые строки
 *    контроля своей фразой с Δ (apps/web/lib/digest.ts, modelWarnings); движок не меняется.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "@so/engine";
import type { BondReportT, BuildResultT, ReportInputs } from "@so/engine/contract";
import type { UIMessage } from "ai";
import { fmt } from "@so/engine/format";
import { findTerm, GLOSSARY, type Term } from "../../lib/glossary";
import { promiseByRules, parsePromise } from "../../lib/jev";
import { digestReport, digestResult } from "../../lib/digest";
import type { ChatSession } from "../../lib/session";
import { type Check, type Verdict, pass, fail, fixture, readSrc, REPO_ROOT, WEB_ROOT } from "../lib";

const THIS_FILE = fileURLToPath(import.meta.url);
const MARK = "@@WP-U-GATE@@";
const ISS_BASE = "https://iss.moex.com";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const show = (v: unknown) => JSON.stringify(v);
const q = (s: unknown, max = 160) => {
  const t = typeof s === "string" ? s : JSON.stringify(s) ?? String(s);
  const one = t.replace(/\s+/g, " ").trim();
  return `«${one.length > max ? one.slice(0, max - 1) + "…" : one}»`;
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/* ═════════════════════════════ дочерний процесс: сценарии гейта ═════════════════════════════ */

type GateMod = typeof import("../../lib/gate");
type Writer = Parameters<GateMod["runGate"]>[0];
type Part = Record<string, unknown> & { at: number; seq: number };

interface JevPlan { intent?: [string, number]; kind?: [string, number]; mentions?: number }
interface JevCall { questions: string[]; message: string; lastAssistant: string | null; numberFound: unknown }
interface IssCall { url: string; file: string | null; start: number; end: number }

/** Состояние подменённой сети дочернего процесса */
const NET = {
  t0: 0,
  delayMs: 0,
  jev: null as JevPlan | null,
  jevCalls: [] as JevCall[],
  iss: [] as IssCall[],
  blocked: [] as string[],
  seq: 0, // порядковый номер события (запись в writer / присваивание session.result) — порядок без опоры на точность таймера
};
const now = () => Math.round((performance.now() - NET.t0) * 10) / 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SNAP_DIRS = [
  path.join(REPO_ROOT, "packages", "engine", "golden", "snapshots", "rolf"),
  path.join(REPO_ROOT, "packages", "engine", "golden", "snapshots", "ofz26238"),
  path.join(REPO_ROOT, "packages", "engine", "audit-fixtures", "sfo_ast0"),
];
/** URL ISS → файл снимка: slug как в iss/client.ts; history с окном дат — по префиксу (окно считается от сегодняшней даты) */
function issFile(u: string): string | null {
  const file = u.replace(ISS_BASE + "/iss/", "").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 150) + ".json";
  for (const d of SNAP_DIRS) if (fs.existsSync(path.join(d, file))) return path.join(d, file);
  if (/_from_/.test(file)) {
    const stem = file.replace(/_from_.*$/, "");
    for (const d of SNAP_DIRS) {
      const cand = fs.readdirSync(d).find((f) => f.startsWith(stem));
      if (cand) return path.join(d, cand);
    }
  }
  return null;
}

function installFetch() {
  const choice = (c: string, p: number) => ({ type: "choice", choice: c, confidence: p, probabilities: { [c]: p } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u === JEV_URL) {
      if (!NET.jev) { NET.blocked.push(u); throw new Error(`аудит WP-U: Jev вызван, хотя сценарий его не ждёт (${u})`); }
      const body = JSON.parse(String(init?.body ?? "{}")) as { state?: Record<string, unknown>; questions?: Record<string, unknown> };
      const qs = body.questions ?? {};
      const st = body.state ?? {};
      NET.jevCalls.push({
        questions: Object.keys(qs), message: String(st.message ?? ""),
        lastAssistant: (st.context as { last_assistant?: string } | undefined)?.last_assistant ?? null, numberFound: st.number_found ?? null,
      });
      const answers: Record<string, unknown> = {};
      if (qs.intent && NET.jev.intent) answers.intent = choice(...NET.jev.intent);
      if (qs.mentions_security) answers.mentions_security = { type: "noul", noul: NET.jev.mentions ?? 0.1 };
      if (qs.kind && NET.jev.kind) answers.kind = choice(...NET.jev.kind);
      if (qs.intent && !answers.intent) throw new Error("аудит WP-U: мок Jev — сценарий не задал ответ на intent");
      if (qs.kind && !answers.kind) throw new Error("аудит WP-U: мок Jev — сценарий не задал ответ на kind");
      return new Response(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: 1000, output_tokens: 0, cost: 0.000042 } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.startsWith(ISS_BASE + "/iss/")) {
      const start = now();
      if (NET.delayMs > 0) await sleep(NET.delayMs);
      const file = issFile(u);
      NET.iss.push({ url: u.replace(ISS_BASE, ""), file: file ? path.relative(REPO_ROOT, file) : null, start, end: now() });
      if (!file) { NET.blocked.push(u); throw new Error(`аудит WP-U: нет снимка ISS для ${u}`); }
      return new Response(fs.readFileSync(file, "utf8"), { status: 200, headers: { "content-type": "application/json" } });
    }
    NET.blocked.push(u);
    throw new Error(`аудит WP-U: сеть запрещена (fetch ${u.slice(0, 100)})`);
  }) as typeof fetch;
}

const importGate = () => import("../../lib/gate") as Promise<GateMod>;
const importJev = () => import("../../lib/jev");

/** Сессия чата, как её собирает getSession (session.ts), с готовым отчётом или без */
function mkSession(id: string, res: BuildResultT | null, pending: ReportInputs | null = null): ChatSession {
  return {
    id, query: res?.kind === "report" ? (res.report.security.isin ?? res.report.security.secid) : null, result: res ? clone(res) : null,
    pendingInputs: pending, userMessages: 0, usage: { input: 0, output: 0, cost: 0, calls: 0, jev: 0 }, touched: Date.now(),
  };
}
const mkWriter = (parts: Part[]): Writer =>
  ({ write: (p: Record<string, unknown>) => { parts.push({ ...p, at: now(), seq: ++NET.seq }); }, merge: () => {} }) as unknown as Writer;
const textOf = (parts: Part[]) => parts.filter((p) => p.type === "text-delta").map((p) => String(p.delta ?? "")).join("").replace(/\s+/g, " ").trim();

interface Turn {
  said: string; handled: boolean; intent: string | null; confidence: number | null; source: string | null; jevError: string | null;
  text: string; tools: { tool: unknown; input: unknown }[];
  kind: string | null; isin: string | null; shortname: string | null; inputs: ReportInputs | null;
  feesK: number | null; feesLine: string | null; panels: string[]; controlFailed: boolean | null; claimLine: string | null;
  jevCalls: JevCall[];
}
async function turn(gate: GateMod, s: ChatSession, said: string, lastAssistant: string | null): Promise<Turn> {
  const parts: Part[] = [];
  const j0 = NET.jevCalls.length;
  const out = await gate.runGate(mkWriter(parts), s, said, lastAssistant);
  const rep = s.result?.kind === "report" ? s.result.report : null;
  return {
    said, handled: out.handled, intent: out.decision?.intent ?? null, confidence: out.decision?.confidence ?? null,
    source: out.decision?.source ?? null, jevError: out.decision?.jevError ?? null,
    text: textOf(parts),
    tools: parts.filter((p) => p.type === "tool-input-available").map((p) => ({ tool: p.toolName, input: p.input })),
    kind: s.result?.kind ?? null, isin: rep?.security.isin ?? null, shortname: rep?.security.shortname ?? null,
    inputs: rep ? rep.inputs : null, feesK: rep?.fees_tax.k_pct ?? null, feesLine: rep?.fees_tax.line ?? null,
    panels: rep?.panels ?? [], controlFailed: rep ? (rep.yield as { control_failed?: boolean }).control_failed ?? null : null,
    claimLine: rep?.claim.line ?? null,
    jevCalls: NET.jevCalls.slice(j0),
  };
}
const liveReport = (name: string): BuildResultT => {
  const res = fixture<BuildResultT>(name);
  if (res.kind !== "report") throw new Error(`${name}: ожидался kind=report, получено ${res.kind}`);
  return res;
};
const setRules = () => { process.env.JEV_ENABLED = "0"; NET.jev = null; };
const setJev = (plan: JevPlan) => { delete process.env.JEV_ENABLED; NET.jev = plan; };

/** Тексты «предыдущего ответа ассистента» (lastAssistant) — правдоподобные реплики сервиса */
const LAST_REPORT = "Отчёт по ОФЗ 26244 собран — смотрите блоки выше. Обещанную доходность сравнил с расчётной — разница в блоке «Доходность». Ни один из red flags не сработал. Напишите сумму, комиссию брокера или сколько вам обещали — пересчитаю.";
const LAST_MODEL = "ОФЗ — облигации федерального займа: их выпускает Минфин России, поэтому кредитный риск у них минимальный на рынке. Назовите выпуск — соберу отчёт.";

/* ───── сценарии ───── */

interface U1Out { threshold: number; base: ReportInputs; a: Turn; b: Turn }
async function scU1(): Promise<U1Out> {
  const gate = await importGate();
  const { jevThreshold } = await importJev();
  const fx = liveReport("live_ofz26244.json");
  const said = "вложу 2 млн, комиссия 0,3%";
  setJev({ intent: ["set_position", 0.84], mentions: 0.05 });
  const a = await turn(gate, mkSession("u1a", fx), said, LAST_REPORT);
  setRules();
  const b = await turn(gate, mkSession("u1b", fx), said, LAST_REPORT);
  return { threshold: jevThreshold(), base: fx.kind === "report" ? fx.report.inputs : {}, a, b };
}

interface U2Out {
  delayMs: number; said: string; handled: boolean; intent: string | null; resultSetAt: number | null; resultSetSeq: number | null; resultKind: string | null;
  writes: { type: string; tool?: string; text?: string; at: number; seq: number }[]; iss: IssCall[]; gateDoneAt: number;
}
async function scU2(): Promise<U2Out> {
  setRules();
  const gate = await importGate();
  NET.delayMs = 250;
  const said = "RU000A10ASE2"; // прод 09.10 21:52: 17,4 с пустого экрана
  const base = mkSession("u2", null);
  let result = base.result;
  let resultSetAt: number | null = null;
  let resultSetSeq: number | null = null;
  const s = { ...base } as ChatSession;
  // момент завершения сборки = присваивание session.result в setResult (сразу после того, как buildCached вернул отчёт)
  Object.defineProperty(s, "result", {
    get: () => result,
    set: (v: BuildResultT | null) => { result = v; if (v && resultSetAt == null) { resultSetAt = now(); resultSetSeq = ++NET.seq; } },
    enumerable: true, configurable: true,
  });
  const parts: Part[] = [];
  NET.t0 = performance.now();
  const out = await gate.runGate(mkWriter(parts), s, said, null);
  const gateDoneAt = now();
  return {
    delayMs: NET.delayMs, said, handled: out.handled, intent: out.decision?.intent ?? null, resultSetAt, resultSetSeq, resultKind: s.result?.kind ?? null,
    writes: parts.map((p) => ({
      type: String(p.type), at: p.at, seq: p.seq,
      ...(p.toolName ? { tool: String(p.toolName) } : {}),
      ...(p.type === "text-delta" ? { text: String(p.delta ?? "").slice(0, 60) } : {}),
    })),
    iss: NET.iss, gateDoneAt,
  };
}

interface U6Row { said: string; variant: string; hasReport: boolean; t: Turn }
interface U6Out { threshold: number; rows: U6Row[] }
async function scU6(): Promise<U6Out> {
  const gate = await importGate();
  const { jevThreshold } = await importJev();
  const fx = liveReport("live_ofz26244.json");
  const rows: U6Row[] = [];
  for (const said of ["предложи ты бумагу", "посоветуй облигацию", "какую облигацию купить?"]) {
    for (const hasReport of [false, true]) {
      setJev({ intent: ["out_of_scope", 0.58], mentions: 0.1 });
      rows.push({ said, variant: "(а) Jev out_of_scope 0,58", hasReport, t: await turn(gate, mkSession(`u6a-${rows.length}`, hasReport ? fx : null), said, hasReport ? LAST_REPORT : LAST_MODEL) });
      setRules();
      rows.push({ said, variant: "(б) JEV_ENABLED=0", hasReport, t: await turn(gate, mkSession(`u6b-${rows.length}`, hasReport ? fx : null), said, hasReport ? LAST_REPORT : LAST_MODEL) });
    }
  }
  return { threshold: jevThreshold(), rows };
}

/** blockOnly — прошлый ход ассистента только с блоком ошибки, без text-части; lastAssistant — visibleAssistantText этого сообщения, как в route.ts */
interface U7Row { hasReport: boolean; said: string; lastAssistant: string; blockOnly?: { label: string; msg: string }; t: Turn }
interface U7Out { threshold: number; rows: U7Row[] }
async function scU7(): Promise<U7Out> {
  const gate = await importGate();
  const { jevThreshold } = await importJev();
  const { ISS_DOWN_MSG } = await import("../../lib/engine");
  const fx = liveReport("live_ofz26244.json");
  const rows: U7Row[] = [];
  for (const hasReport of [true, false]) {
    setJev({ intent: ["out_of_scope", 0.9], mentions: 0.05 });
    const last = hasReport ? LAST_REPORT : LAST_MODEL;
    rows.push({ hasReport, said: "ты уверен?", lastAssistant: last, t: await turn(gate, mkSession(`u7-${hasReport}`, hasReport ? fx : null), "ты уверен?", last) });
  }
  // Ход только с блоком ошибки (err гейта без текста после правки дубля 20.10; {error} set_inputs без отчёта) — тоже ответ ассистента:
  // «почему?» после него — уточнение, а не «не по теме»; Jev получает текст ошибки, а не ""
  const NO_REPORT = "Отчёт ещё не собран — сначала назовите бумагу.";
  const blockOnly: { label: string; msg: string; part: Record<string, unknown> }[] = [
    { label: "err resolve_security (Мосбиржа не отвечает)", msg: ISS_DOWN_MSG, part: {
      type: "tool-resolve_security", toolCallId: "u7-err", state: "output-available", input: { query: "RU000A1038V6" },
      output: { query: "RU000A1038V6", result: { kind: "err", query: "RU000A1038V6", msg: ISS_DOWN_MSG } } } },
    { label: "{error} set_inputs без отчёта", msg: NO_REPORT, part: {
      type: "tool-set_inputs", toolCallId: "u7-noreport", state: "output-available", input: { position_size: 1_000_000 }, output: { error: NO_REPORT } } },
  ];
  for (const b of blockOnly) {
    setJev({ intent: ["out_of_scope", 0.9], mentions: 0.05 });
    const msg = { id: "u7-a", role: "assistant", parts: [{ type: "step-start" }, b.part] } as unknown as UIMessage;
    const last = gate.visibleAssistantText(msg);
    rows.push({ hasReport: false, said: "почему?", lastAssistant: last, blockOnly: { label: b.label, msg: b.msg },
      t: await turn(gate, mkSession(`u7-block-${rows.length}`, null), "почему?", last || null) });
  }
  return { threshold: jevThreshold(), rows };
}

interface U8Out { a: Turn; aPending: ReportInputs; b: Turn; iss: IssCall[] }
async function scU8(): Promise<U8Out> {
  setRules();
  const gate = await importGate();
  const aPending: ReportInputs = { position_size: 1_000_000, k_pct: 0.3 };
  const a = await turn(gate, mkSession("u8a", null, aPending), "Проверь RU000A1038V6, обещали 15%", null);
  const b = await turn(gate, mkSession("u8b", null), "Проверь RU000A10AST0, обещали 26%", null);
  return { a, aPending, b, iss: NET.iss };
}

interface U9Out { threshold: number; jevTurns: Turn[]; rulesTurn: Turn }
async function scU9(): Promise<U9Out> {
  const gate = await importGate();
  const { jevThreshold } = await importJev();
  const jevTurns: Turn[] = [];
  for (const said of ["RU000A10ASE2", "Проверь RU000A10AST0"]) {
    setJev({ intent: ["check_security", 0.95], kind: ["annual_yield", 0.9], mentions: 0.95 });
    jevTurns.push(await turn(gate, mkSession(`u9j-${jevTurns.length}`, null), said, null));
  }
  setRules();
  const rulesTurn = await turn(gate, mkSession("u9r", null), "Проверь RU000A10AST0, обещали много", null);
  return { threshold: jevThreshold(), jevTurns, rulesTurn };
}

interface U10Out { steps: Turn[] }
async function scU10(): Promise<U10Out> {
  setRules();
  const gate = await importGate();
  const s = mkSession("u10", null);
  const steps: Turn[] = [];
  for (const said of ["Проверь RU000A1038V6", "вложу 2 млн", "комиссия 0,3%", "Проверь RU000A10ASE2"])
    steps.push(await turn(gate, s, said, steps.length ? steps[steps.length - 1].text : null));
  return { steps };
}

const SCENARIOS: Record<string, () => Promise<unknown>> = { "U.1": scU1, "U.2": scU2, "U.6": scU6, "U.7": scU7, "U.8": scU8, "U.9": scU9, "U.10": scU10 };

async function childMain(name: string): Promise<void> {
  const nm = (await import("node:module")) as unknown as { registerHooks?: (hooks: unknown) => unknown };
  if (typeof nm.registerHooks !== "function") throw new Error("node:module.registerHooks недоступен — нужен Node ≥ 22.15");
  nm.registerHooks({
    resolve(spec: string, ctx: unknown, next: (s: string, c: unknown) => unknown) {
      if (spec === "server-only") return { url: "data:text/javascript,", shortCircuit: true, format: "module" };
      return next(spec, ctx);
    },
  });
  const fn = SCENARIOS[name];
  if (!fn) throw new Error(`неизвестный сценарий: «${name}»`);
  NET.t0 = performance.now();
  installFetch();
  const out = await fn();
  // stdout в pipe на macOS асинхронный: дождаться сброса строки до process.exit, иначе длинный JSON обрежется
  await new Promise<void>((res) => process.stdout.write(MARK + JSON.stringify({ scenario: name, blocked: NET.blocked, out }) + "\n", () => res()));
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(THIS_FILE); } catch { return false; }
}
if (isMain()) {
  const i = process.argv.indexOf("--scenario");
  childMain(i >= 0 ? process.argv[i + 1] ?? "" : "").then(
    () => process.exit(0),
    (e) => { console.error(e); process.exit(3); },
  );
}

/* ═════════════════════════════ родитель: запуск сценария, мемоизация ═════════════════════════════ */

let usageDirPath: string | null = null;
function usageDir(): string {
  if (usageDirPath) return usageDirPath;
  usageDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "so-audit-u-usage-"));
  const dir = usageDirPath;
  process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}
interface ChildEnvelope<T> { scenario: string; blocked: string[]; out: T }
const memo = new Map<string, { ok: true; v: ChildEnvelope<unknown> } | { ok: false; err: Error }>();
function scenario<T>(name: string): ChildEnvelope<T> {
  const m = memo.get(name);
  if (m) { if (m.ok) return m.v as ChildEnvelope<T>; throw m.err; }
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env, NODE_NO_WARNINGS: "1", SO_USAGE_DIR: usageDir(), SO_USAGE_LOG: "0", SO_QUIET: "1",
      JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "audit-fake-key",
    };
    for (const k of ["SO_OFFLINE", "TYPESAFE_URL", "JEV_DECISIONS_URL", "JEV_ENABLED", "MOCK_LLM", "JEV_THRESHOLD", "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY", "LLM_PROVIDER", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
    const r = spawnSync(process.execPath, ["--import", "tsx", THIS_FILE, "--scenario", name], {
      cwd: WEB_ROOT, env, encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    const line = String(r.stdout ?? "").split("\n").reverse().find((l) => l.startsWith(MARK));
    if (r.status !== 0 || !line) {
      const tail = String(r.stderr ?? "").trim().split("\n").slice(-8).join(" | ");
      throw new Error(`сценарий ${name}: exit=${r.status} signal=${r.signal ?? "-"}; stderr: ${tail || "(пусто)"}`);
    }
    const v = JSON.parse(line.slice(MARK.length)) as ChildEnvelope<T>;
    if (v.scenario !== name) throw new Error(`сценарий ${name}: пришёл результат «${v.scenario}»`);
    memo.set(name, { ok: true, v });
    return v;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    memo.set(name, { ok: false, err });
    throw err;
  }
}

/* ───── форматирование ───── */
const inp = (i: ReportInputs | null) => (i ? `position_size=${show(i.position_size)}, k_pct=${show(i.k_pct)}, promised_pct=${show(i.promised_pct)}` : "отчёта нет");
const route = (t: Turn) => `${t.intent ?? "—"} ${t.confidence ?? "—"} (${t.source ?? "—"}${t.jevError ? `, jevError=${q(t.jevError, 60)}` : ""})`;
const blockedNote = (b: string[]) => (b.length ? ` | ВНИМАНИЕ: заблокированные обращения в сеть (${b.length}): ${b.slice(0, 3).map((u) => u.slice(0, 90)).join("; ")}` : "");

/* ═════════════════════════════ проверки ═════════════════════════════ */

const U1: Check = {
  id: "U.1", wp: "U", kind: "fixture",
  title: "«вложу 2 млн, комиссия 0,3%» при собранном отчёте (ОФЗ 26244) → position_size=2 000 000 И k_pct=0,3, строка комиссий учитывает 0,3% — и при Jev set_position 0,84 (прод 09.10 12:29), и на правилах (JEV_ENABLED=0)",
  run(): Verdict {
    const { out: o, blocked } = scenario<U1Out>("U.1");
    const judge = (t: Turn) => {
      const okPos = t.inputs?.position_size === 2_000_000;
      const okK = t.inputs?.k_pct === 0.3 && t.feesK === 0.3;
      const okLine = t.panels.includes("fees") ? (t.feesLine ?? "").includes("0,3%") : true;
      return { ok: t.handled && okPos && okK && okLine, okPos, okK, okLine };
    };
    const ja = judge(o.a), jb = judge(o.b);
    const row = (name: string, t: Turn, j: ReturnType<typeof judge>) =>
      `${name}: маршрут ${route(t)}, handled=${t.handled}; после runGate ${inp(t.inputs)} (ожид. 2000000 и 0.3) — сумма ${j.okPos ? "ок" : "НЕ применена"}, комиссия ${j.okK ? "ок" : "НЕ 0,3"}; ` +
      `fees_tax.k_pct=${show(t.feesK)}, строка комиссий ${q(t.feesLine, 110)}${j.okLine ? "" : " — без 0,3%"}; set_inputs=${show(t.tools.map((x) => x.input))}; текст гейта ${q(t.text, 140)}`;
    const detail = `реплика «вложу 2 млн, комиссия 0,3%», база live_ofz26244: ${inp(o.base)}; порог Jev ${o.threshold} | ` +
      `${row("(а) Jev set_position 0,84", o.a, ja)} | ${row("(б) правила", o.b, jb)}${blockedNote(blocked)}`;
    return ja.ok && jb.ok ? pass(detail) : fail(detail);
  },
};

const U2: Check = {
  id: "U.2", wp: "U", kind: "fixture",
  title: "Индикатор ожидания: при check_security первая запись в writer (tool-input-available инструмента отчёта или текст «собираю…») уходит ДО завершения сборки отчёта (ISS медленный: задержка каждого ответа)",
  run(): Verdict {
    const { out: o, blocked } = scenario<U2Out>("U.2");
    const early = o.writes.find((w) => (w.type === "tool-input-available" && /resolve_security|build_bond_report/.test(w.tool ?? "")) || (w.type === "text-delta" && /собира/i.test(w.text ?? "")));
    const first = o.writes[0];
    const issStart = o.iss.length ? o.iss[0].start : null;
    const issEnd = o.iss.length ? Math.max(...o.iss.map((c) => c.end)) : null;
    const slowOk = o.iss.length >= 3 && o.resultSetAt != null && o.resultSetAt >= o.delayMs * 3;
    // порядок — по номеру события (запись раньше присваивания результата), время — для наглядности
    const ok = slowOk && early != null && o.resultSetSeq != null && early.seq < o.resultSetSeq;
    const detail =
      `реплика ${q(o.said)} (правила → ${o.intent}, handled=${o.handled}); ISS-мок: ${o.iss.length} запросов по ${o.delayMs} мс, первый в ${show(issStart)} мс, последний ответ в ${show(issEnd)} мс; ` +
      `сборка завершена (setResult, kind=${o.resultKind}) в ${show(o.resultSetAt)} мс, событие №${show(o.resultSetSeq)}${slowOk ? "" : " — ПРЕДУСЛОВИЕ: сборка не медленная/не прошла через ISS-мок, замер непоказателен"}; ` +
      `первая запись в writer: ${first ? `${first.type}${first.tool ? " " + first.tool : ""} в ${first.at} мс, событие №${first.seq}` : "нет записей"}; ` +
      `первая «ранняя» (tool-input-available отчёта или «собираю…»): ${early ? `${early.type}${early.tool ? " " + early.tool : ""} в ${early.at} мс, событие №${early.seq}` : "нет"} — ожид. раньше завершения сборки (№${show(o.resultSetSeq)}, ${show(o.resultSetAt)} мс); ` +
      `все записи (тип@мс#№): ${o.writes.map((w) => `${w.type}${w.tool ? "(" + w.tool + ")" : ""}@${w.at}#${w.seq}`).join(", ")}; гейт вернулся в ${o.gateDoneAt} мс${blockedNote(blocked)}`;
    return ok ? pass(detail) : fail(detail);
  },
};

/** Статьи глоссария, которые есть сейчас и посвящены ДРУГИМ понятиям (базовым терминам U.3 они не засчитываются) */
const EXISTING_IDS = new Set(["nkd", "ytm", "offer", "call", "float", "duration", "gspread", "spread", "amort", "listlevel", "truth", "qual", "worst", "tax"]);
const termStr = (t: Term | null) => (t ? `${t.id} «${t.title}»` : "null");
const U3: Check = {
  id: "U.3", wp: "U", kind: "unit",
  title: "Глоссарий: базовые термины есть — findTerm для «Что такое облигация?», «что такое ОФЗ», «Что такое купон?», «номинал», «погашение» находит статью именно об этом",
  run(): Verdict {
    const cases: Array<[string, RegExp]> = [
      ["Что такое облигация?", /облигаци/i],
      ["что такое ОФЗ", /офз|федеральн[а-я]* займ/i],
      ["Что такое купон?", /купон/i],
      ["номинал", /номинал/i],
      ["погашение", /погашени/i],
    ];
    const rows = cases.map(([s, re]) => {
      const t = findTerm(s);
      const about = t != null && !EXISTING_IDS.has(t.id) && re.test([t.title, ...t.aliases].join(" "));
      return { s, t, ok: about };
    });
    const bad = rows.filter((r) => !r.ok);
    const detail = `${rows.length - bad.length}/${rows.length} находят статью о термине; ` +
      rows.map((r) => `${q(r.s)}→${termStr(r.t)}${r.ok ? " ок" : r.t ? " — статья о другом понятии" : " — не найдено"}`).join("; ") +
      ` | статей в глоссарии ${GLOSSARY.length}: ${GLOSSARY.map((g) => g.id).join(", ")}`;
    return bad.length === 0 ? pass(detail) : fail(detail);
  },
};

const U4: Check = {
  id: "U.4", wp: "U", kind: "unit",
  title: "Глоссарий: падежи и опечатки — «Срок дюрации», «Срок драции», «объясни дюрацию», «расскажи про оферту», «что такое амортизация облигации» находят дюрацию/оферту/амортизацию",
  run(): Verdict {
    const cases: Array<[string, string]> = [
      ["Срок дюрации", "duration"], ["Срок драции", "duration"], ["объясни дюрацию", "duration"],
      ["расскажи про оферту", "offer"], ["что такое амортизация облигации", "amort"],
    ];
    const missingIds = [...new Set(cases.map(([, id]) => id))].filter((id) => !GLOSSARY.some((g) => g.id === id));
    const rows = cases.map(([s, id]) => { const t = findTerm(s); return { s, id, t, ok: t?.id === id }; });
    const bad = rows.filter((r) => !r.ok);
    const detail = `${rows.length - bad.length}/${rows.length} ок; ` +
      rows.map((r) => `${q(r.s)}→${termStr(r.t)} (ожид. ${r.id})${r.ok ? " ок" : " — НЕ ок"}`).join("; ") +
      (missingIds.length ? ` | статей ${missingIds.join(", ")} в глоссарии нет` : ` | статьи duration/offer/amort в глоссарии есть; поиск — подстрока алиаса в тексте реплики`);
    return bad.length === 0 ? pass(detail) : fail(detail);
  },
};

const U5: Check = {
  id: "U.5", wp: "U", kind: "unit",
  title: "Глоссарий: нет ложных совпадений — «путь», «спутник», «скоро погашение?», «13% годовых это много?» не находят посторонних статей (оферта по «пут», Truth Score по «скор», налог по «13%»)",
  run(): Verdict {
    // допустимо: null или статья о том же понятии (для «погашение» — о погашении, для «13% годовых» — о доходности)
    const cases: Array<[string, (t: Term) => boolean, string]> = [
      ["путь", () => false, "только null"],
      ["спутник", () => false, "только null"],
      ["скоро погашение?", (t) => !EXISTING_IDS.has(t.id) && /погашени/i.test(t.title), "null или статья «Погашение»"],
      ["13% годовых это много?", (t) => t.id === "ytm" || (!EXISTING_IDS.has(t.id) && /доходност/i.test(t.title)), "null или статья о доходности"],
    ];
    const rows = cases.map(([s, okT, want]) => { const t = findTerm(s); return { s, t, want, ok: t == null || okT(t) }; });
    const bad = rows.filter((r) => !r.ok);
    const why = (t: Term, s: string) => {
      const a = t.aliases.find((x) => s.toLowerCase().replace(/ё/g, "е").includes(x.replace(/ё/g, "е")));
      return a ? ` (сработал алиас «${a}» как подстрока)` : "";
    };
    const detail = `${rows.length - bad.length}/${rows.length} без посторонних статей; ` +
      rows.map((r) => `${q(r.s)}→${termStr(r.t)}${r.t && !r.ok ? why(r.t, r.s) : ""} — ожид. ${r.want}${r.ok ? " ок" : " — ПОСТОРОННЯЯ"}`).join("; ");
    return bad.length === 0 ? pass(detail) : fail(detail);
  },
};

const REFUSAL_ADVICE = /совет|рекомендац/i;
const U6: Check = {
  id: "U.6", wp: "U", kind: "fixture",
  title: "Просьба о совете («предложи ты бумагу», «посоветуй облигацию», «какую облигацию купить?») → гейт сам отвечает детерминированным отказом от рекомендаций (handled=true, без LLM) — и при Jev out_of_scope 0,58 (прод 10.10 19:55), и на правилах",
  run(): Verdict {
    const { out: o, blocked } = scenario<U6Out>("U.6");
    const rows = o.rows.map((r) => ({ ...r, ok: r.t.handled && REFUSAL_ADVICE.test(r.t.text) }));
    const bad = rows.filter((r) => !r.ok);
    const detail = `${rows.length - bad.length}/${rows.length} ок (порог Jev ${o.threshold}); ` +
      rows.map((r) => `${q(r.said)} ${r.variant}, отчёт ${r.hasReport ? "есть" : "нет"}: маршрут ${route(r.t)} → handled=${r.t.handled}` +
        (r.t.handled ? `, текст ${q(r.t.text, 100)}` : " — реплика ушла бы модели (отказ держится только на промпте)")).join("; ") + blockedNote(blocked);
    return bad.length === 0 ? pass(detail) : fail(detail);
  },
};

const TEMPLATE_REFUSAL = /помогаю только с проверкой облигаций/i;
const U7: Check = {
  id: "U.7", wp: "U", kind: "fixture",
  title: "Уточнение «ты уверен?» после ответа ассистента (Jev out_of_scope 0,9) — не шаблонный отказ «Я помогаю только с проверкой облигаций…» (передача модели или ответ по контексту допустимы); с отчётом и без. " +
    "И после хода только с блоком ошибки, без текста (err resolve_security «Мосбиржа не отвечает», {error} set_inputs без отчёта): lastAssistant = visibleAssistantText сообщения = текст ошибки, " +
    "«почему?» передаётся модели, в Jev уходит last_assistant = текст ошибки; route.ts передаёт в runGate visibleAssistantText(lastAssistant)",
  run(): Verdict {
    const { out: o, blocked } = scenario<U7Out>("U.7");
    const rows = o.rows.map((r) => {
      const refusal = r.t.handled && TEMPLATE_REFUSAL.test(r.t.text);
      const jevLast = r.t.jevCalls[0]?.lastAssistant ?? null;
      const why = r.blockOnly ? [
        r.lastAssistant !== r.blockOnly.msg ? `lastAssistant ${q(r.lastAssistant, 60)} ≠ сообщению блока` : "",
        r.t.handled ? "handled=true (ожид. передача модели)" : "",
        jevLast !== r.blockOnly.msg ? `в Jev ушло last_assistant ${q(jevLast ?? "", 60)} ≠ сообщению блока` : "",
      ].filter(Boolean) : [];
      return { ...r, refusal, jevLast, why };
    });
    // route.ts — именно этот helper в аргументе runGate (иначе ход только с блоком снова даёт lastAssistant = null)
    const routeSrc = readSrc("apps/web/app/api/chat/route.ts").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const routeOk = /runGate\(\s*writer\s*,\s*session\s*,\s*text\s*,\s*visibleAssistantText\(\s*lastAssistant\s*\)/.test(routeSrc);
    const bad = rows.filter((r) => r.refusal || r.why.length);
    const detail = `порог Jev ${o.threshold}; ` + rows.map((r) => (r.blockOnly
      ? `после хода только с блоком (${r.blockOnly.label}): lastAssistant = visibleAssistantText → ${q(r.lastAssistant, 60)}; ${q(r.said)}: ` +
        `маршрут ${route(r.t)} → handled=${r.t.handled}, ${r.t.handled ? `текст ${q(r.t.text, 120)}` : "передано модели"}, в Jev ушло last_assistant ${q(r.jevLast ?? "", 60)}` +
        `${r.refusal ? " — ШАБЛОННЫЙ ОТКАЗ" : ""}${r.why.length ? ` — ${r.why.join("; ")}` : " ок"}`
      : `отчёт ${r.hasReport ? "есть" : "нет"}, lastAssistant ${q(r.lastAssistant, 60)} (в Jev ушло last_assistant ${r.jevLast ? `${r.jevLast.length} симв.` : "пусто"}): ` +
        `маршрут ${route(r.t)} → handled=${r.t.handled}, ${r.t.handled ? `текст ${q(r.t.text, 120)}` : "передано модели"}${r.refusal ? " — ШАБЛОННЫЙ ОТКАЗ" : " ок"}`)).join(" | ") +
      ` | route.ts: runGate(writer, session, text, visibleAssistantText(lastAssistant) …) ${routeOk ? "есть" : "НЕТ — lastAssistant считается не по видимому тексту"}` + blockedNote(blocked);
    return bad.length === 0 && routeOk ? pass(detail) : fail(detail);
  },
};

const ASK_SUM = /(напишите|укажите|назовите|введите|сообщите)[^.!?]*сумм/i;
const ASK_K = /(напишите|укажите|назовите|введите|сообщите)[^.!?]*комисси/i;
const ASK_PROMISED = /сколько (вам )?(обещали|пообещали)/i;
const U8: Check = {
  id: "U.8", wp: "U", kind: "fixture",
  title: "Хвост ответа после отчёта учитывает состояние: (а) при уже применённых сумме 1 млн, комиссии 0,3% и «обещали 15%» не просит их снова; (б) при гейте контроля (ССекьюр_А RU000A10AST0, блок комиссий скрыт) не зовёт ввести комиссию",
  run(): Verdict {
    const { out: o, blocked } = scenario<U8Out>("U.8");
    const a = o.a, b = o.b;
    const aPre = a.kind === "report" && a.inputs?.position_size === 1_000_000 && a.inputs?.k_pct === 0.3 && a.inputs?.promised_pct === 15;
    const aAsks = [ASK_SUM.test(a.text) && "сумму", ASK_K.test(a.text) && "комиссию", ASK_PROMISED.test(a.text) && "«сколько обещали»"].filter(Boolean) as string[];
    const bPre = b.kind === "report" && b.controlFailed === true && !b.panels.includes("fees");
    const bAsksK = ASK_K.test(b.text);
    const okA = aPre && aAsks.length === 0;
    const okB = bPre && !bAsksK;
    const detail =
      `(а) «Проверь RU000A1038V6, обещали 15%» при pendingInputs ${show(o.aPending)}: маршрут ${route(a)}, ${a.kind} ${a.shortname ?? ""}, применено ${inp(a.inputs)}` +
      `${aPre ? "" : " — ПРЕДУСЛОВИЕ не выполнено (вводы не применились)"}; инструмент ${show(a.tools.map((t) => t.tool))}; текст ${q(a.text, 260)} → снова просит: ${aAsks.length ? aAsks.join(", ") : "ничего"} (ожид. ничего) | ` +
      `(б) «Проверь RU000A10AST0, обещали 26%»: ${b.kind} ${b.shortname ?? ""}, control_failed=${show(b.controlFailed)}, панели ${b.panels.join(",")} (fees ${b.panels.includes("fees") ? "есть" : "скрыт"})` +
      `${bPre ? "" : " — ПРЕДУСЛОВИЕ не выполнено (гейт контроля не сработал / блок комиссий виден)"}; текст ${q(b.text, 260)} → зовёт ввести комиссию: ${bAsksK} (ожид. false)` +
      ` | ISS-мок: ${o.iss.length} запросов, без снимка ${o.iss.filter((c) => !c.file).length}${blockedNote(blocked)}`;
    return okA && okB ? pass(detail) : fail(detail);
  },
};

const U9: Check = {
  id: "U.9", wp: "U", kind: "fixture",
  title: "Разбор «обещали»: цифры ISIN — не обещание (promiseByRules/parsePromise «RU000A10ASE2» → value null); «Проверь RU000A10AST0, обещали много» → promised_pct null; check_security без «обещ/сул/говор» не вызывает Jev для parsePromise",
  async run(): Promise<Verdict> {
    // часть 1 — чистые функции в процессе харнеса (правила; Jev выключен, fetch — заглушка)
    const r1 = promiseByRules("RU000A10ASE2");
    const saved = { en: process.env.JEV_ENABLED, f: globalThis.fetch };
    process.env.JEV_ENABLED = "0";
    globalThis.fetch = (async (u: unknown) => { throw new Error(`аудит WP-U: сеть запрещена (${String(u).slice(0, 80)})`); }) as typeof fetch;
    let p1;
    try { p1 = await parsePromise("RU000A10ASE2"); }
    finally { if (saved.en === undefined) delete process.env.JEV_ENABLED; else process.env.JEV_ENABLED = saved.en; globalThis.fetch = saved.f; }
    const r2 = promiseByRules("Проверь RU000A10AST0, обещали много");
    const ok1 = r1.value == null && p1.value == null;

    // часть 2 — гейт в дочернем процессе
    const { out: o, blocked } = scenario<U9Out>("U.9");
    const g = o.rulesTurn;
    const ok2 = g.kind === "report" && g.inputs != null && g.inputs.promised_pct == null;
    const kindCalls = o.jevTurns.map((t) => ({ said: t.said, route: t.jevCalls.filter((c) => c.questions.includes("intent")).length, kind: t.jevCalls.filter((c) => c.questions.includes("kind")), t }));
    const ok3 = kindCalls.every((k) => k.kind.length === 0) && kindCalls.every((k) => k.t.handled);
    const detail =
      `(1) promiseByRules(«RU000A10ASE2»)→kind=${r1.kind}, value=${show(r1.value)}, annualized=${show(r1.annualized)}; parsePromise (JEV_ENABLED=0)→value=${show(p1.value)} (ожид. null оба); ` +
      `справочно promiseByRules(«Проверь RU000A10AST0, обещали много»)→value=${show(r2.value)} | ` +
      `(2) гейт на правилах «Проверь RU000A10AST0, обещали много»: маршрут ${route(g)}, ${g.kind} ${g.shortname ?? ""}, promised_pct=${show(g.inputs?.promised_pct)} (ожид. null), claim.line=${q(g.claimLine, 90)}, текст ${q(g.text, 110)} | ` +
      `(3) гейт с Jev-моком (intent check_security 0,95; порог ${o.threshold}): ` +
      kindCalls.map((k) => `${q(k.said)} → handled=${k.t.handled}, вызовов Jev: маршрут ${k.route}, parsePromise/kind ${k.kind.length}${k.kind.length ? ` (number_found=${show(k.kind[0].numberFound)})` : ""} (ожид. 0), promised_pct=${show(k.t.inputs?.promised_pct)}`).join("; ") +
      blockedNote(blocked);
    return ok1 && ok2 && ok3 ? pass(detail) : fail(detail);
  },
};

const RESET_NOTE = /сброс|сброш|по умолчанию|не перенес|не сохран|заново укаж|снова укаж|заново назов|снова назов/i;
const U10: Check = {
  id: "U.10", wp: "U", kind: "fixture",
  title: "Новая бумага в том же чате не сбрасывает молча вводы: отчёт A → «вложу 2 млн» → «комиссия 0,3%» → «Проверь B»: у B position_size 2 000 000 и k_pct 0,3 ЛИБО текст явно говорит, что сумма/комиссия сброшены",
  run(): Verdict {
    const { out: o, blocked } = scenario<U10Out>("U.10");
    const [a, pos, k, b] = o.steps;
    const pre = a?.kind === "report" && pos?.inputs?.position_size === 2_000_000 && k?.inputs?.k_pct === 0.3 && k?.inputs?.position_size === 2_000_000;
    const carried = b?.inputs?.position_size === 2_000_000 && b?.inputs?.k_pct === 0.3;
    const told = b != null && b.text.split(/(?<=[.!?…])\s+/).some((s) => RESET_NOTE.test(s) && /сумм|позици|комисси/i.test(s));
    const ok = pre && b?.kind === "report" && b.isin !== a?.isin && (carried || told);
    const detail = o.steps.map((t, i) => `${i + 1}) ${q(t.said)} → ${route(t)}, handled=${t.handled}, ${t.kind ?? "—"} ${t.shortname ?? ""}: ${inp(t.inputs)}`).join(" | ") +
      `${pre ? "" : " | ПРЕДУСЛОВИЕ не выполнено: вводы A не применились"} | у B (${b?.isin}) вводы ${carried ? "перенесены" : "НЕ перенесены"}; текст ответа ${q(b?.text, 220)} → сообщает о сбросе суммы/комиссии: ${told}${blockedNote(blocked)}`;
    return ok ? pass(detail) : fail(detail);
  },
};

/* ───── U.11: дайджест модели для отчёта с гейтом контроля ───── */
interface Leaf { path: string; value: string | number | boolean }
function leaves(o: unknown, p = "$"): Leaf[] {
  if (typeof o === "string" || typeof o === "number" || typeof o === "boolean") return [{ path: p, value: o }];
  if (Array.isArray(o)) return o.flatMap((v, i) => leaves(v, `${p}[${i}]`));
  if (o && typeof o === "object") return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${p}.${k}`));
  return [];
}
async function ast0Report(): Promise<BondReportT> {
  const dir = path.join(REPO_ROOT, "packages", "engine", "audit-fixtures", "sfo_ast0");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { query: string; todayIso: string; inputs?: Record<string, number> };
  const res = await build(meta.query, meta.inputs ?? {}, { fromSnapshotDir: dir, todayIso: meta.todayIso });
  if (res.kind !== "report") throw new Error(`audit-fixtures/sfo_ast0: ожидался kind=report, получено ${res.kind}`);
  return res.report;
}
const JARGON: Array<[string, RegExp]> = [["«гейт»", /гейт/i], ["«сетка комиссий»", /сетк[аи]\s+комисси/i], ["ярлык «контроль:»", /контроль\s*:/i]];
const CALL_NOT_CALC = /к\s+коллу[^.;]*не\s+рассчитан|не\s+рассчитан[^.;]*к\s+коллу/i;
const U11: Check = {
  id: "U.11", wp: "U", kind: "fixture",
  title: "Дайджест модели при гейте контроля (ССекьюр_А, build(sfo_ast0)): сигнал есть (control_failed / «не сошёлся»), но без собственного расчёта (own_control_pct), жаргона («гейт», «сетка комиссий», «контроль:») и фразы «…к коллу не рассчитан…» при главной доходности к коллу",
  async run(): Promise<Verdict> {
    const r = await ast0Report();
    const y = r.yield as BondReportT["yield"] & { control_failed?: boolean };
    const d = digestReport(r);
    const viaResult = digestResult({ kind: "report", report: r });
    const L = [...leaves(d), ...leaves(viaResult).map((l) => ({ ...l, path: "digestResult" + l.path.slice(1) }))];
    const strs = L.filter((l): l is Leaf & { value: string } => typeof l.value === "string");
    const pre = y.control_failed === true && y.own_control_pct != null;
    const signal = L.some((l) => /control_failed$/.test(l.path) && l.value === true) || strs.some((l) => /не сошёл|не сошл/i.test(l.value));
    const own = y.own_control_pct;
    const ownForms = own == null ? [] : [...new Set([fmt(own, 2), own.toFixed(2), String(own)])];
    const ownHits: Leaf[] = [...strs.filter((l) => ownForms.some((f) => l.value.includes(f))), ...L.filter((l) => typeof l.value === "number" && l.value === own)];
    const jargonHits = JARGON.flatMap(([name, re]) => strs.filter((l) => re.test(l.value)).map((l) => `${name} в ${l.path}`));
    const mainToCall = y.horizon === "call";
    const callHits = mainToCall ? strs.filter((l) => CALL_NOT_CALC.test(l.value)).map((l) => l.path) : [];
    const ok = pre && signal && ownHits.length === 0 && jargonHits.length === 0 && callHits.length === 0;
    const prompt = readSrc("apps/web/lib/prompt.ts");
    const detail =
      `отчёт ${r.security.shortname} ${r.security.isin}: control_failed=${show(y.control_failed)}, главная ${show(y.main_pct)}% (horizon=${y.horizon}, ${q(y.values.map((v) => v.label).join(", "), 40)}), own_control_pct=${show(own)}, Δ=${show(y.control_diff_pp)}` +
      `${pre ? "" : " — ПРЕДУСЛОВИЕ: гейт контроля не сработал на снимке"} | сигнал гейта модели передан: ${signal} (ожид. true, совместимо с D.2) | ` +
      `собственный расчёт ${ownForms.join("/") || "—"} в дайджесте: ${ownHits.length ? ownHits.map((l) => l.path).join(", ") : "нет"} (ожид. нет) | ` +
      `жаргон: ${jargonHits.length ? jargonHits.join(", ") : "нет"} (ожид. нет) | «к коллу не рассчитан» при главной к коллу: ${callHits.length ? callHits.join(", ") : "нет"} (ожид. нет) | ` +
      `фрагмент дайджеста: warnings=${q(d.warnings, 330)}; yield_line=${q(d.yield_line, 120)}; control_failed=${show(d.control_failed)} | ` +
      `справочно: правило в SYSTEM_PROMPT, как объяснять расхождение контроля: ${/контрол|не сош[её]л|расхожден/i.test(prompt) ? "есть упоминание" : "нет"}`;
    return ok ? pass(detail) : fail(detail);
  },
};

export const checks: Check[] = [U1, U2, U3, U4, U5, U6, U7, U8, U9, U10, U11];
