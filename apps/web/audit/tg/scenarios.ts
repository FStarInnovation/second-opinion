/**
 * WP-TG: сценарии с сервером в ДОЧЕРНЕМ процессе (§6 «Как устроен», как wp-u-gate.ts): `engine.ts` фиксирует SO_OFFLINE при
 * импорте и ищет golden от cwd, `session.ts`/`budget.ts` фиксируют лимиты при импорте, `budget.ts`/`usage-log.ts` — каталог
 * .usage; поэтому каждый сценарий — свой процесс со своим окружением.
 *
 * ── Родитель (проверка в wp-tg.ts) ──
 *   const r = scenario<Out>("parity:tg3");                       // синхронно, spawnSync
 *   if (!r.ok) return fail(`сценарий упал: ${r.error}`);         // исключение в сценарии → RED с текстом ошибки
 *   r.out …; r.blocked (заблокированные обращения в сеть); r.unhandled (unhandledRejection в ребёнке)
 *   Запуск: `node --import tsx apps/web/audit/tg/scenarios.ts --scenario <group>:<name>`, cwd = apps/web.
 *   Окружение §6: SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0; ключи LLM/Jev и их настройки сняты; SO_USAGE_DIR — НОВЫЙ временный
 *   каталог на каждый запуск (удаляется после; свой у каждого сценария — так «limits» не исчерпывает бюджет паритету);
 *   SO_USAGE_LOG=1; SO_BOT_KEY = TG_TEST.botKey; SO_DAILY_BUDGET_USD=2; SO_MESSAGE_LIMIT, SO_APP_DIR, NODE_ENV, TG_* и SO_TG_*
 *   и прокси удалены; SO_QUIET=1. `opts.env` переопределяет (undefined — удалить): `scenario("limits:g1", { env: { SO_MESSAGE_LIMIT: "2" } })`,
 *   `scenario("health-version:a", { env: { SO_APP_DIR: tmp } })`. Мемоизация по name + env: повторный вызов не запускает процесс.
 *   Дефект харнеса (процесс не стартовал, таймаут, exit≠0, нет строки MARK, неизвестная группа/сценарий) → исключение → ERROR
 *   (текст начинается с «сценарий <name>:»; таймаут — с кодом ETIMEDOUT: группы parity и server превращают его в RED).
 *   Сценарий, у которого цикл событий опустел, а промис не разрешился, отдаёт конверт ok:false («сценарий не завершился…»).
 *
 * ── Ребёнок ──
 *   Разбирает `--scenario "<group>:<name>"`, ставит хук "server-only" → пустой модуль, глушит внешний fetch (бросает, URL пишется
 *   в blocked), ловит unhandledRejection (пишется в unhandled, процесс не падает), затем:
 *     group "infra" — встроенные сценарии этого файла (selftest, env);
 *     иначе        — `import("./scen-<group>.ts")` и `await run(name)`; результат (JSON-сериализуемый, не undefined) уходит родителю
 *                    одной строкой `MARK + JSON` в stdout. run(name) для чужого имени должен вернуть undefined → ERROR «неизвестный сценарий».
 *   Авторы групп пишут сценарии в отдельных файлах apps/web/audit/tg/scen-<group>.ts:
 *     import { loadServer, readUsage, TG_TEST } from "./scenarios";
 *     export async function run(name: string): Promise<unknown> { if (name === "tg3") { const srv = await loadServer(); … } }
 *   Хелперы ребёнка: loadServer() (budget, usage, session, gate, route, engine + botFetch = (url, init) => route.POST(new Request(url, init))),
 *   readUsage()/readUsageRaw() (usage.jsonl), readBudget(), writeBudget(), netBlocked().
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WEB_ROOT } from "../lib";
import { loadDialog } from "./actions";
import { assembleUIMessage, canonical, diff, normalizeMessage } from "./normalize";
import type { BotConfig, RecordedRequest } from "./types";

type BudgetMod = typeof import("../../lib/budget");
type UsageMod = typeof import("../../lib/usage-log");
type SessionMod = typeof import("../../lib/session");
type GateMod = typeof import("../../lib/gate");
type EngineMod = typeof import("../../lib/engine");
type RouteMod = typeof import("../../app/api/chat/route");

const THIS_FILE = fileURLToPath(import.meta.url);
const TG_DIR = path.dirname(THIS_FILE);
/** Префикс строки результата ребёнка в stdout */
export const MARK = "@@WP-TG-SCENARIO@@";

/** Тестовые секреты и адреса. token — в форме токена Bot API «<цифры>:<строка>» (в URL Bot API он идёт как «bot<токен>»; для проверки вырезания в журнале, TG.18/TG.20) */
export const TG_TEST = {
  botKey: "audit-tg-bot-key-6f1c2a9d4e7b0c35",
  salt: "audit-tg-salt-0b5e93c1d7a24f68",
  token: "7012345678:AAH-audit-fake-token-zz9QqWwEeRrTtYyUu",
  botHandle: "so_audit_test_bot",
  webUrl: "http://127.0.0.1:3000",
} as const;

/** Конфигурация ядра бота для харнеса (§4.4 BotConfig): сервер TG_TEST.webUrl, тестовый ключ и соль, allow "*", щедрые лимиты */
export function testBotConfig(over: Partial<BotConfig> = {}): BotConfig {
  return {
    webUrl: TG_TEST.webUrl, botKey: TG_TEST.botKey, salt: TG_TEST.salt, allow: "*", dailyTurns: 1000, concurrency: 4,
    perChatPending: 2, maxChats: 300, turnTimeoutMs: 90_000, ...over,
  };
}
/** Детерминированный random(n) для CoreDeps (xorshift32 от seed): разные вызовы — разные байты, прогоны воспроизводимы */
export function testRandom(seed = 0x5eed1234): (n: number) => Uint8Array {
  let x = seed >>> 0 || 1;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; }
    return out;
  };
}

/** Переменные, которые снимаются из унаследованного окружения (кроме *_API_KEY — они снимаются все) */
const STRIP = [
  "LLM_PROVIDER", "JEV_PROVIDER", "JEV_THRESHOLD", "JEV_MODEL", "JEV_MODEL_OPENROUTER", "JEV_TIMEOUT_MS", "TYPESAFE_URL", "JEV_DECISIONS_URL",
  "OPENROUTER_MODEL", "OPENROUTER_FALLBACK_MODEL", "ANTHROPIC_MODEL", "SO_MESSAGE_LIMIT", "SO_APP_DIR", "SO_CHAT", "NODE_ENV",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NODE_OPTIONS",
];
/** Окружение §6 поверх унаследованного (без over) */
export const SCENARIO_ENV = {
  SO_OFFLINE: "1", MOCK_LLM: "1", JEV_ENABLED: "0", SO_USAGE_LOG: "1", SO_BOT_KEY: TG_TEST.botKey, SO_DAILY_BUDGET_USD: "2", SO_QUIET: "1",
} as const;

/** Полное окружение дочернего процесса: унаследованное − STRIP − *_API_KEY − TG_* и SO_TG_* + SCENARIO_ENV + SO_USAGE_DIR + over */
export function scenarioEnv(usageDir: string, over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (STRIP.includes(k) || /_API_KEY$/.test(k) || /^(TG_|SO_TG)/.test(k) || k === "SO_SITE_URL") delete env[k];
  Object.assign(env, { NODE_NO_WARNINGS: "1", ...SCENARIO_ENV, SO_USAGE_DIR: usageDir });
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

/* ═══════════════════════════ родитель ═══════════════════════════ */

interface Envelope<T> { scenario: string; ok: boolean; out?: T; error?: string; blocked: string[]; unhandled: string[] }
export type ScenarioResult<T> =
  | { ok: true; name: string; out: T; blocked: string[]; unhandled: string[]; ms: number; stderr: string }
  | { ok: false; name: string; error: string; blocked: string[]; unhandled: string[]; ms: number; stderr: string };

const memo = new Map<string, { ok: true; v: ScenarioResult<unknown> } | { ok: false; err: Error }>();

/**
 * Запустить сценарий «<group>:<name>» в дочернем процессе (синхронно) и вернуть его результат.
 * @param opts.env       переопределения окружения §6 (undefined — удалить переменную); SO_USAGE_DIR задаётся новым временным каталогом,
 *                       если не передан явно (тогда каталог ваш и не удаляется)
 * @param opts.timeoutMs таймаут процесса (по умолчанию 180 000 мс)
 * @returns `{ok:true, out}` или `{ok:false, error}` (исключение внутри сценария); `blocked` — URL заблокированных fetch,
 *          `unhandled` — unhandledRejection ребёнка, `stderr` — хвост stderr (для detail)
 * @throws дефект харнеса: процесс не стартовал / таймаут / exit≠0 / нет строки MARK / неизвестная группа или сценарий → ERROR
 */
export function scenario<T>(name: string, opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {}): ScenarioResult<T> {
  const key = name + "\u0000" + canonical(opts.env ?? {});
  const m = memo.get(key);
  if (m) { if (m.ok) return m.v as ScenarioResult<T>; throw m.err; }
  const given = opts.env?.SO_USAGE_DIR;
  const own = given ? null : fs.mkdtempSync(path.join(os.tmpdir(), "so-audit-tg-usage-"));
  const t0 = Date.now();
  try {
    const { SO_USAGE_DIR: _ignored, ...over } = opts.env ?? {};
    void _ignored;
    const env = scenarioEnv(given ?? own!, over);
    const r = spawnSync(process.execPath, ["--import", "tsx", THIS_FILE, "--scenario", name], {
      cwd: WEB_ROOT, env, encoding: "utf8", timeout: opts.timeoutMs ?? 180_000, maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) throw Object.assign(new Error(`сценарий ${name}: ${r.error.message}`), { code: (r.error as NodeJS.ErrnoException).code, cause: r.error });
    const stderr = String(r.stderr ?? "").trim().split("\n").slice(-8).join(" | ");
    const line = String(r.stdout ?? "").split("\n").reverse().find((l) => l.startsWith(MARK));
    if (r.status !== 0 || !line)
      throw new Error(`сценарий ${name}: exit=${r.status} signal=${r.signal ?? "-"}${line ? "" : ", нет строки результата"}; stderr: ${stderr || "(пусто)"}`);
    const v = JSON.parse(line.slice(MARK.length)) as Envelope<T>;
    if (v.scenario !== name) throw new Error(`сценарий ${name}: пришёл результат «${v.scenario}»`);
    const base = { name, blocked: v.blocked ?? [], unhandled: v.unhandled ?? [], ms: Date.now() - t0, stderr };
    const res: ScenarioResult<T> = v.ok ? { ok: true, out: v.out as T, ...base } : { ok: false, error: v.error ?? "(нет текста ошибки)", ...base };
    memo.set(key, { ok: true, v: res });
    return res;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    memo.set(key, { ok: false, err });
    throw err;
  } finally {
    if (own) try { fs.rmSync(own, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Пометка для detail: заблокированные обращения в сеть и unhandledRejection ребёнка (пусто, если их не было) */
export function scenarioNotes(r: { blocked: string[]; unhandled: string[] }): string {
  const parts: string[] = [];
  if (r.blocked.length) parts.push(`заблокированные обращения в сеть (${r.blocked.length}): ${r.blocked.slice(0, 3).map((u) => u.slice(0, 90)).join("; ")}`);
  if (r.unhandled.length) parts.push(`unhandledRejection (${r.unhandled.length}): ${r.unhandled.slice(0, 2).map((u) => u.slice(0, 120)).join("; ")}`);
  return parts.length ? ` | ВНИМАНИЕ: ${parts.join(" | ")}` : "";
}

/* ═══════════════════════════ ребёнок: общее состояние ═══════════════════════════ */

interface ChildState { child: boolean; started: boolean; blocked: string[]; unhandled: string[]; server: Promise<Server> | null }
const STATE_KEY = Symbol.for("so.audit.tg.scenarios.v1");
/** Состояние ребёнка на globalThis: модуль мог бы загрузиться дважды под разными URL — состояние и запуск всё равно одни */
function st(): ChildState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: ChildState };
  return (g[STATE_KEY] ??= { child: false, started: false, blocked: [], unhandled: [], server: null });
}
const assertChild = (what: string) => {
  if (!st().child) throw new Error(`${what}: только в дочернем процессе сценария (scenario("<group>:<name>") в родителе)`);
};

/** URL заблокированных обращений внешнего fetch (копия) */
export const netBlocked = (): string[] => [...st().blocked];

async function installHooks(): Promise<void> {
  const mod = (await import("node:module")) as unknown as { registerHooks?: (h: unknown) => unknown; register: (spec: string) => void };
  if (typeof mod.registerHooks === "function") {
    mod.registerHooks({
      resolve(spec: string, ctx: unknown, next: (s: string, c: unknown) => unknown) {
        if (spec === "server-only") return { url: "data:text/javascript,", shortCircuit: true, format: "module" };
        return next(spec, ctx);
      },
    });
  } else {
    const hook = `export async function resolve(s, c, n) { if (s === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true }; return n(s, c); }`;
    mod.register("data:text/javascript," + encodeURIComponent(hook));
  }
}

function installNetGuard(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    st().blocked.push(u);
    throw new Error(`аудит WP-TG: внешняя сеть запрещена (fetch ${u.slice(0, 100)}); бот ходит в сервер через botFetch`);
  }) as typeof fetch;
}

/* ═══════════════════════════ ребёнок: сервер ═══════════════════════════ */

export interface ServerCall {
  seq: number; url: string; method: string;
  /** все заголовки запроса, имена в нижнем регистре */
  headers: Record<string, string>;
  /** тело как JSON (или сырая строка, если не JSON) */
  body: unknown;
  rawBody: string;
  status: number;
  ms: number;
}
export interface Server {
  budget: BudgetMod; usage: UsageMod; session: SessionMod; gate: GateMod; engine: EngineMod; route: RouteMod;
  /** fetch бота: (url, init) => route.POST(new Request(url, init)) для POST …/api/chat; иное → 404 (и запись в calls) */
  fetch: typeof fetch;
  /** каждый вызов fetch по порядку */
  calls: ServerCall[];
  /** POST /api/chat с телом (объект → JSON) и заголовками (по умолчанию content-type: application/json) через тот же fetch */
  post(body: unknown, headers?: Record<string, string>): Promise<Response>;
  /** POST записанного запроса браузера: заголовки эталона (content-type, x-so-chat) + тело; over — правка заголовков (undefined — снять) и тела */
  postRecorded(r: RecordedRequest, over?: { headers?: Record<string, string | undefined>; body?: unknown }): Promise<Response>;
}

/**
 * Серверные модули в дочернем процессе (один экземпляр на процесс; повторный вызов — тот же объект).
 * Порядок импорта: budget → usage-log → session → engine → gate → app/api/chat/route (как wp-h.ts).
 */
export function loadServer(): Promise<Server> {
  assertChild("loadServer");
  return (st().server ??= (async () => {
    const budget = await import("../../lib/budget");
    const usage = await import("../../lib/usage-log");
    const session = await import("../../lib/session");
    const engine = await import("../../lib/engine");
    const gate = await import("../../lib/gate");
    const route = await import("../../app/api/chat/route");
    const calls: ServerCall[] = [];
    const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request && init === undefined ? input : new Request(input, init);
      const rawBody = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
      let body: unknown = rawBody;
      try { body = rawBody ? JSON.parse(rawBody) : null; } catch { /* не JSON — сырая строка */ }
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      const t0 = Date.now();
      const isChat = req.method === "POST" && new URL(req.url).pathname === "/api/chat";
      const res = isChat ? await route.POST(req) : new Response(`аудит WP-TG: ${req.method} ${new URL(req.url).pathname} не обслуживается`, { status: 404 });
      calls.push({ seq: calls.length + 1, url: req.url, method: req.method, headers, body, rawBody, status: res.status, ms: Date.now() - t0 });
      return res;
    }) as typeof fetch;
    const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
      doFetch(`${TG_TEST.webUrl}/api/chat`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    const postRecorded = (r: RecordedRequest, over: { headers?: Record<string, string | undefined>; body?: unknown } = {}) => {
      const h: Record<string, string> = { ...r.headers };
      for (const [k, v] of Object.entries(over.headers ?? {})) { if (v === undefined) delete h[k.toLowerCase()]; else h[k.toLowerCase()] = v; }
      return post(over.body !== undefined ? over.body : r.body, h);
    };
    return { budget, usage, session, gate, engine, route, fetch: doFetch, calls, post, postRecorded };
  })());
}

/** Каталог журнала ребёнка (SO_USAGE_DIR) */
export const usageDir = (): string => String(process.env.SO_USAGE_DIR ?? "");
/** usage.jsonl ребёнка как текст ("" — файла нет) */
export function readUsageRaw(): string {
  assertChild("readUsageRaw");
  const f = path.join(usageDir(), "usage.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
}
/** Записи usage.jsonl ребёнка по порядку (нечитаемые строки пропускаются) */
export function readUsage(): Record<string, unknown>[] {
  return readUsageRaw().split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
}
/** budget.json ребёнка (null — файла нет) */
export function readBudget(): { day: string; spent: number; messages: number } | null {
  assertChild("readBudget");
  const f = path.join(usageDir(), "budget.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as { day: string; spent: number; messages: number }) : null;
}
/** Записать budget.json ребёнка (budget.ts перечитывает файл на каждый вызов): напр. исчерпать бюджет — `writeBudget({ day: mskDay(), spent: 2, messages: 0 })` */
export function writeBudget(b: { day: string; spent: number; messages: number }): void {
  assertChild("writeBudget");
  fs.mkdirSync(usageDir(), { recursive: true });
  fs.writeFileSync(path.join(usageDir(), "budget.json"), JSON.stringify(b));
}

/* ═══════════════════════════ встроенные сценарии infra:* ═══════════════════════════ */

export interface SelftestOut {
  status: number;
  contentType: string | null;
  chunkTypes: string[];
  errors: string[];
  /** собранное ai сообщение ассистента (ответ на тело 1 d1) */
  message: unknown;
  /** N(сборка) ≡ N(сообщение ассистента в теле 2 d1) */
  equal: boolean;
  diff: string | null;
  usageSteps: string[];
  calls: number;
}
/** infra:selftest — тело 1 d1 («ОФЗ 26238») через route.POST, сборка ai, сравнение с сообщением ассистента из тела 2 d1 */
async function selftest(): Promise<SelftestOut> {
  const d1 = loadDialog("d1");
  const srv = await loadServer();
  const res = await srv.postRecorded(d1.requests[0]);
  const ctype = res.headers.get("content-type");
  const asm = await assembleUIMessage(res);
  const expected = d1.requests[1].body.messages[1];
  const d = diff(normalizeMessage(expected), normalizeMessage(asm.message), { path: "message", labels: ["браузер (d1, тело 2)", "сборка ai"] });
  return {
    status: asm.status, contentType: ctype, chunkTypes: asm.chunks.map((c) => c.type), errors: asm.errors, message: asm.message,
    equal: d === null, diff: d, usageSteps: readUsage().map((r) => String(r.step)), calls: srv.calls.length,
  };
}
/** infra:env — окружение ребёнка (то, что фиксируют модули при импорте) и работа заглушки сети */
async function envProbe(): Promise<Record<string, unknown>> {
  const keys = ["SO_OFFLINE", "MOCK_LLM", "JEV_ENABLED", "SO_USAGE_LOG", "SO_DAILY_BUDGET_USD", "SO_MESSAGE_LIMIT", "SO_APP_DIR", "NODE_ENV", "SO_QUIET"];
  let guard = "не бросил";
  try { await fetch("https://example.com/"); } catch (e) { guard = String(e).slice(0, 120); }
  return {
    env: Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null])),
    botKeySet: process.env.SO_BOT_KEY === TG_TEST.botKey,
    apiKeys: Object.keys(process.env).filter((k) => /_API_KEY$/.test(k)),
    usageDirIsTmp: usageDir().startsWith(os.tmpdir()),
    cwd: process.cwd(),
    guard,
  };
}
const INFRA: Record<string, () => Promise<unknown>> = { selftest, env: envProbe };

/* ═══════════════════════════ ребёнок: запуск ═══════════════════════════ */

class HarnessDefect extends Error {}

/** «<group>:<name>» → функция сценария; неизвестная группа/сценарий — HarnessDefect (exit 3 → ERROR у родителя) */
async function resolveScenario(spec: string): Promise<() => Promise<unknown> | unknown> {
  const i = spec.indexOf(":");
  const group = i > 0 ? spec.slice(0, i) : "";
  const name = i > 0 ? spec.slice(i + 1) : "";
  if (!group || !name) throw new HarnessDefect(`сценарий «${spec}»: нужен формат <group>:<name>`);
  if (group === "infra") {
    const fn = INFRA[name];
    if (!fn) throw new HarnessDefect(`неизвестный сценарий infra:${name}`);
    return fn;
  }
  if (!/^[a-z0-9-]+$/.test(group)) throw new HarnessDefect(`имя группы «${group}»: только [a-z0-9-]`);
  const file = path.join(TG_DIR, `scen-${group}.ts`);
  if (!fs.existsSync(file)) throw new HarnessDefect(`нет файла сценариев группы «${group}»: ${path.relative(WEB_ROOT, file)}`);
  const mod = (await import(pathToFileURL(file).href)) as { run?: (name: string) => Promise<unknown> | unknown };
  if (typeof mod.run !== "function") throw new HarnessDefect(`${path.basename(file)}: нет export run(name)`);
  return () => mod.run!(name);
}

async function childMain(spec: string): Promise<number> {
  const s = st();
  s.child = true;
  process.on("unhandledRejection", (r) => { s.unhandled.push(String(r instanceof Error ? `${r.name}: ${r.message}` : r).slice(0, 300)); });
  await installHooks();
  installNetGuard();
  let fn: () => Promise<unknown> | unknown;
  try {
    fn = await resolveScenario(spec);
  } catch (e) {
    console.error(e);
    return 3; // дефект харнеса → родитель бросит → ERROR
  }
  // stdout процесса, а не возможная подмена (scen-parity подменяет process.stdout.write на время ходов бота): строка MARK дойдёт до родителя
  const writeOut = process.stdout.write.bind(process.stdout) as (s: string, cb: () => void) => boolean;
  let env: Envelope<unknown>;
  // Зависание без активных хэндлов (маршрут ждёт промис, который никто не разрешит): цикл событий опустеет, и процесс вышел бы
  // с кодом 0 без строки результата (ERROR у родителя). Вместо этого — конверт ok:false → у проверки RED с понятной причиной.
  let finished = false;
  process.once("beforeExit", () => {
    if (finished) return;
    finished = true;
    const stuck: Envelope<unknown> = {
      scenario: spec, ok: false, blocked: s.blocked, unhandled: s.unhandled,
      error: "сценарий не завершился: цикл событий опустел, а промис сценария не разрешился (маршрут завис? route.POST / channelOf / health ждут промис, который никто не разрешит)",
    };
    writeOut(MARK + JSON.stringify(stuck) + "\n", () => process.exit(0));
  });
  try {
    const out = await fn();
    if (out === undefined) { console.error(`неизвестный сценарий ${spec}: run() вернул undefined`); return 3; }
    env = { scenario: spec, ok: true, out, blocked: s.blocked, unhandled: s.unhandled };
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`).split("\n").slice(0, 4).join(" | ") : String(e);
    env = { scenario: spec, ok: false, error: msg.slice(0, 1500), blocked: s.blocked, unhandled: s.unhandled };
  }
  finished = true;
  let line: string;
  try { line = MARK + JSON.stringify(env) + "\n"; } catch (e) { console.error(`результат ${spec} не сериализуется в JSON: ${String(e)}`); return 3; }
  // stdout в pipe бывает асинхронным: дождаться сброса строки до process.exit, иначе длинный JSON обрежется
  await new Promise<void>((res) => writeOut(line, () => res()));
  return 0;
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(THIS_FILE); } catch { return false; }
}
if (isMain() && !st().started) {
  st().started = true;
  const i = process.argv.indexOf("--scenario");
  childMain(i >= 0 ? process.argv[i + 1] ?? "" : "").then(
    (code) => process.exit(code),
    (e) => { console.error(e); process.exit(3); },
  );
}
