/**
 * WP-R (apps/web) — проверки по docs/AUDIT_PLAN_2026-10-09.md, § WP-R (R.6-web, R.7-web, R.8).
 * Каждая не-guard проверка утверждает ЖЕЛАЕМОЕ поведение (до правки — RED); guard — инварианты, зелёные уже сейчас.
 *
 * Как устроено. apps/web/lib/engine.ts читает SO_OFFLINE один раз при загрузке модуля и импортирует "server-only"
 * (пакет резолвится только бандлером Next), поэтому сценарии гоняются в ДОЧЕРНЕМ процессе
 * `node --import tsx <этот файл> --scenario <offline|iss500|route-schema>` (cwd = apps/web, как у Next):
 *   - "server-only" подменяется пустым модулем через module.registerHooks ДО импорта engine.ts;
 *   - offline: SO_OFFLINE=1 → buildCached читает golden-снимок rolf (RU000A10ASE2 = «РОЛЬФ 1Р07»), а обработчики
 *     /api/report (route.ts) вызываются напрямую с объектом Request — сервер и сеть не нужны;
 *   - iss500: SO_OFFLINE снят — это ПРОДОВАЯ ветвь buildCached (`build(query, baseInputs)`), globalThis.fetch подменён:
 *     сначала HTTP 500 на любой URL, затем «ISS из снимка» (URL → файл снимка по тому же slug, что в
 *     packages/engine/src/iss/client.ts; любой поиск /iss/securities.json?q=… → строка РОЛЬФ 1Р07 из снимка) —
 *     так видно, лёг ли сбой в кэш и ключуется ли кэш по SECID на онлайн-пути;
 *   - route-schema: тем же хуком импорт "@/lib/engine" в route.ts подменяется заглушкой, чей buildCached отдаёт
 *     заданный конверт (golden-отчёт rolf с built_at-сентинелом — валидный; он же с испорченным полем — не проходит
 *     BondReport). Обработчики /api/report вызываются напрямую: видно, валидирует ли маршрут отчёт перед Response.json.
 *     fetch в этом сценарии бросает исключение — сеть исключена даже при промахе подмены.
 * Дочерний процесс печатает одну JSON-строку с маркером; родитель мемоизирует результат на все проверки WP.
 * Сеть не используется ни в одном сценарии (все fetch — подменённые), статусы детерминированы.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Check, type Verdict, expect, fail, pass, readSrc, REPO_ROOT, WEB_ROOT } from "../lib";

const THIS_FILE = fileURLToPath(import.meta.url);
const MARK = "@@WP-R@@";
const ISIN = "RU000A10ASE2"; // РОЛЬФ 1Р07 — golden-кейс rolf
const SHORTNAME = "РОЛЬФ 1Р07"; // та же бумага, вторая форма записи (shortname из строки поиска ISS / эталона)
const SNAP_ROLF = path.join(REPO_ROOT, "packages", "engine", "golden", "snapshots", "rolf");
const GOLDEN_ROLF = path.join(REPO_ROOT, "packages", "engine", "golden", "expected", "rolf.json"); // эталонный отчёт — база для route-schema
const SEARCH_FILE = "securities_json_q_RU000A10ASE2_iss_meta_off.json"; // ответ ISS на поиск: одна строка РОЛЬФ 1Р07 / RU000A10ASE2
const ISS_BASE = "https://iss.moex.com";
const POS = 750_000; // сумма вложения, отличимая от CONFIG.positionDefault (500 000)
const SENTINEL_BUILT_AT = "2000-01-01T00:00:00.000Z"; // built_at заглушки: отличает её отчёт от реальной сборки движка
const STUB_KEY = "__wpR_engineStub"; // globalThis[STUB_KEY] — функция, которую вызывает заглушка @/lib/engine
const ROUTE_SRC = "apps/web/app/api/report/route.ts";

type ScenarioName = "offline" | "iss500" | "route-schema";

/* ───────────────────────────── типы результатов сценариев ───────────────────────────── */

interface Built { kind: string; secid: string | null; built_at: string | null; status: string | null; main: number | null; msg: string | null }
interface Attempt extends Partial<Built> {
  query: string; resolved: boolean; errName?: string; errKind?: string; errStatus?: number; errMsg?: string;
  fetchCalls: number; searches: string[]; ms: number;
}
interface RouteCase {
  name: string; method: "GET" | "POST"; req: string; valid: boolean;
  status: number; kind: string; neChislo: boolean; schemaOk: boolean | null; schemaIssue: string | null;
  claimLine: string | null; promised: unknown; pos: unknown; k: unknown; f12: string | null;
}
interface SchemaCase {
  name: string; method: "GET" | "POST"; corrupt: string | null; stubCalls: number;
  status: number; kind: string; msg: string | null; built_at: string | null; schemaOk: boolean | null; schemaIssue: string | null;
}
interface OfflineOut { scenario: "offline"; offline: boolean; positionDefault: number | null; a: Built; b: Built; c: Built; gapMs: number | null; routes: RouteCase[] }
interface Iss500Out { scenario: "iss500"; offline: boolean; step1: Attempt; step2: Attempt; step3: Attempt; step4: Attempt; gapMs24: number | null }
interface RouteSchemaOut { scenario: "route-schema"; baseValid: boolean; baseIssue: string | null; cases: SchemaCase[] }

/* ───────────────────────────── дочерний процесс: сценарии ───────────────────────────── */

type BuildResultLike = { kind: string; msg?: string; report?: Record<string, any> };
type EngineMod = { buildCached: (q: string, inputs?: Record<string, unknown>) => Promise<BuildResultLike>; isOffline: () => boolean };
type RouteMod = { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
type SafeParse = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };
type ContractMod = { BondReport: { safeParse: (x: unknown) => SafeParse } };
type ConfigMod = { CONFIG: { positionDefault?: number } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const importEngine = () => import(pathToFileURL(path.join(WEB_ROOT, "lib", "engine.ts")).href) as Promise<EngineMod>;
const importRoute = () => import(pathToFileURL(path.join(WEB_ROOT, "app", "api", "report", "route.ts")).href) as Promise<RouteMod>;
const importContract = () => import("@so/engine/contract") as unknown as Promise<ContractMod>;
const importConfig = () => import("@so/engine/config") as unknown as Promise<ConfigMod>;
const issues = (sp: SafeParse | null) =>
  sp && !sp.success ? (sp.error?.issues ?? []).slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : null;

function built(r: BuildResultLike | null | undefined): Built {
  const rep = r?.kind === "report" ? r.report ?? null : null;
  return {
    kind: String(r?.kind), secid: rep?.security?.secid ?? null, built_at: rep?.built_at ?? null,
    status: rep?.status?.kind ?? null, main: rep?.yield?.main_pct ?? null, msg: r?.msg ?? null,
  };
}

/**
 * «ISS из снимка»: тот же slug, что в iss/client.ts; history с окном дат — по префиксу (окно зависит от сегодня);
 * любой поиск /iss/securities.json?q=… → SEARCH_FILE (одна строка РОЛЬФ 1Р07 / RU000A10ASE2), q записывается в onSearch.
 * Граница: строка отдаётся на ЛЮБОЙ q, без фильтрации по совпадению — токенный поиск (план WP-R) тоже её получит;
 * объединение нескольких поисков без дедупликации по SECID дало бы две одинаковые строки → pick (это было бы видно в detail R.8-guard).
 */
function snapshotFetch(onCall: () => void, onSearch: (q: string) => void): typeof fetch {
  const slug = (u: string) => u.replace(ISS_BASE + "/iss/", "").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 150);
  const json = (file: string) =>
    new Response(fs.readFileSync(path.join(SNAP_ROLF, file), "utf8"), { status: 200, headers: { "content-type": "application/json" } });
  return (async (input: RequestInfo | URL) => {
    onCall();
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(u);
    if (url.pathname === "/iss/securities.json" && url.searchParams.has("q")) {
      onSearch(url.searchParams.get("q") ?? "");
      return json(SEARCH_FILE);
    }
    let file = slug(u) + ".json";
    if (!fs.existsSync(path.join(SNAP_ROLF, file))) {
      const stem = file.replace(/_from_.*$/, "");
      const cand = fs.readdirSync(SNAP_ROLF).find((f) => f.startsWith(stem));
      if (!cand) return new Response(`нет снимка ${file}`, { status: 404 });
      file = cand;
    }
    return json(file);
  }) as typeof fetch;
}

const noNetwork = (async (input: unknown) => {
  throw new Error(`аудит WP-R: сеть запрещена (fetch ${String(typeof input === "object" && input && "url" in input ? (input as { url: string }).url : input).slice(0, 80)})`);
}) as typeof fetch;

async function scenarioOffline(): Promise<OfflineOut> {
  const eng = await importEngine();
  const positionDefault = (await importConfig().catch(() => null))?.CONFIG?.positionDefault ?? null;
  const a = built(await eng.buildCached(ISIN, { promised_pct: 26 }));
  await sleep(1100); // чтобы повторная сборка была видна даже при секундной точности built_at
  const b = built(await eng.buildCached(SHORTNAME, { promised_pct: 26 }));
  const c = built(await eng.buildCached(ISIN, { promised_pct: 26 }));
  const gapMs = a.built_at && b.built_at ? Date.parse(b.built_at) - Date.parse(a.built_at) : null;

  const route = await importRoute();
  const { BondReport } = await importContract();
  const routes: RouteCase[] = [];
  const base = "http://localhost/api/report";
  const run = async (name: string, valid: boolean, method: "GET" | "POST", qs: string, body?: unknown) => {
    const req = method === "GET"
      ? new Request(`${base}?${qs}`)
      : new Request(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const res = await (method === "GET" ? route.GET(req) : route.POST(req));
    const text = await res.text();
    let json: BuildResultLike | null = null;
    try { json = JSON.parse(text) as BuildResultLike; } catch { json = null; }
    const rep = json?.kind === "report" ? json.report ?? null : null;
    const sp = rep ? BondReport.safeParse(rep) : null;
    routes.push({
      name, method, req: method === "GET" ? `?${qs}` : JSON.stringify(body), valid,
      status: res.status, kind: String(json?.kind), neChislo: text.includes("не число"),
      schemaOk: sp ? sp.success : null, schemaIssue: issues(sp),
      claimLine: rep?.claim?.line ?? null, promised: rep?.claim?.promised_pct ?? null,
      pos: rep?.liquidity?.position_size ?? null, k: rep?.fees_tax?.k_pct ?? null,
      f12: rep?.flags?.find((f: { id: number }) => f.id === 12)?.details ?? null,
    });
  };
  // невалидный ввод (желаемое: kind err, HTTP 4xx, никаких «не число»)
  await run("GET promised=abc (NaN)", false, "GET", `q=${ISIN}&promised=abc`);
  await run("GET pos=-5 (< 1000)", false, "GET", `q=${ISIN}&pos=-5`);
  await run("GET k=50 (> 3)", false, "GET", `q=${ISIN}&k=50`);
  await run("GET promised=1000 (> 100)", false, "GET", `q=${ISIN}&promised=1000`);
  await run("POST promised_pct:'abc'", false, "POST", "", { query: ISIN, inputs: { promised_pct: "abc" } });
  await run("POST position_size:-5", false, "POST", "", { query: ISIN, inputs: { position_size: -5 } });
  // валидный ввод (guard: отчёт собирается, ввод применён; pos = 750 000 ≠ CONFIG.positionDefault — потеря pos была бы видна)
  await run(`GET promised=26&pos=${POS}&k=0.3`, true, "GET", `q=${ISIN}&promised=26&pos=${POS}&k=0.3`);
  await run(`POST promised_pct:26, position_size:${POS}`, true, "POST", "", { query: ISIN, inputs: { promised_pct: 26, position_size: POS } });

  return { scenario: "offline", offline: eng.isOffline(), positionDefault, a, b, c, gapMs, routes };
}

async function scenarioIss500(): Promise<Iss500Out> {
  const eng = await importEngine();
  const realFetch = globalThis.fetch;
  let calls = 0;
  let searches: string[] = [];
  const attempt = async (query: string, inputs: Record<string, unknown> = {}): Promise<Attempt> => {
    calls = 0; searches = [];
    const t0 = Date.now();
    try {
      const r = await eng.buildCached(query, inputs);
      return { query, resolved: true, ...built(r), fetchCalls: calls, searches: [...searches], ms: Date.now() - t0 };
    } catch (e) {
      const err = e as { constructor?: { name?: string }; kind?: string; status?: number; message?: string };
      return {
        query, resolved: false, errName: err?.constructor?.name ?? "Error", errKind: err?.kind, errStatus: err?.status,
        errMsg: err?.message ?? String(e), fetchCalls: calls, searches: [...searches], ms: Date.now() - t0,
      };
    }
  };
  try {
    globalThis.fetch = (async () => { calls++; return new Response("boom", { status: 500 }); }) as typeof fetch;
    const step1 = await attempt(ISIN); // ISS отвечает 500
    globalThis.fetch = snapshotFetch(() => calls++, (q) => searches.push(q));
    const step2 = await attempt(ISIN); // ISS «ожил»: тот же запрос — должен собраться отчёт, а не кэш ошибки
    const step3 = await attempt(ISIN); // повтор удачного: должен прийти из кэша без обращений к ISS
    await sleep(1100); // чтобы повторная сборка была видна даже при секундной точности built_at
    const step4 = await attempt(SHORTNAME); // та же бумага другой формой записи (онлайн-путь): желаемое — отчёт из кэша по SECID
    const gapMs24 = step2.built_at && step4.built_at ? Date.parse(step4.built_at) - Date.parse(step2.built_at) : null;
    return { scenario: "iss500", offline: eng.isOffline(), step1, step2, step3, step4, gapMs24 };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/**
 * route-schema: "@/lib/engine" уже подменён заглушкой (childMain) — её buildCached/rebuild вызывают globalThis[STUB_KEY].
 * Каждый кейс задаёт конверт, который «вернёт движок», и дёргает обработчик /api/report напрямую.
 */
async function scenarioRouteSchema(): Promise<RouteSchemaOut> {
  globalThis.fetch = noNetwork;
  const { BondReport } = await importContract();
  const golden = JSON.parse(fs.readFileSync(GOLDEN_ROLF, "utf8")) as BuildResultLike;
  if (golden.kind !== "report" || !golden.report) throw new Error(`${GOLDEN_ROLF}: ожидался конверт {kind:"report"}, пришёл ${String(golden.kind)}`);
  const baseRep: Record<string, any> = { ...golden.report, built_at: SENTINEL_BUILT_AT };
  const baseSp = BondReport.safeParse(baseRep);

  let stubCalls = 0;
  let current: BuildResultLike = { kind: "report", report: baseRep };
  (globalThis as unknown as Record<string, unknown>)[STUB_KEY] = async () => { stubCalls++; return current; };
  const route = await importRoute();

  const cases: SchemaCase[] = [];
  const base = "http://localhost/api/report";
  const run = async (name: string, method: "GET" | "POST", corrupt: string | null, mutate: ((r: Record<string, any>) => void) | null) => {
    const rep = structuredClone(baseRep);
    if (mutate) mutate(rep);
    current = { kind: "report", report: rep };
    stubCalls = 0;
    const req = method === "GET"
      ? new Request(`${base}?q=${ISIN}&promised=26`)
      : new Request(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: ISIN, inputs: { promised_pct: 26 } }) });
    const res = await (method === "GET" ? route.GET(req) : route.POST(req));
    const text = await res.text();
    let json: BuildResultLike | null = null;
    try { json = JSON.parse(text) as BuildResultLike; } catch { json = null; }
    const outRep = json?.kind === "report" ? json.report ?? null : null;
    const sp = outRep ? BondReport.safeParse(outRep) : null;
    cases.push({
      name, method, corrupt, stubCalls, status: res.status, kind: String(json?.kind), msg: json?.msg ?? null,
      built_at: outRep?.built_at ?? null, schemaOk: sp ? sp.success : null, schemaIssue: issues(sp),
    });
  };
  await run("валидный golden-отчёт rolf", "GET", null, null);
  await run("валидный golden-отчёт rolf", "POST", null, null);
  const promisedAbc = (r: Record<string, any>) => { r.claim.promised_pct = "abc"; };
  await run("claim.promised_pct=\"abc\"", "GET", "claim.promised_pct: строка вместо number|null", promisedAbc);
  await run("claim.promised_pct=\"abc\"", "POST", "claim.promised_pct: строка вместо number|null", promisedAbc);
  await run("yield.main_pct=\"не число\"", "GET", "yield.main_pct: строка вместо number", (r) => { r.yield.main_pct = "не число"; });
  await run("без security", "GET", "security отсутствует (обязательный объект)", (r) => { delete r.security; });

  return { scenario: "route-schema", baseValid: baseSp.success, baseIssue: issues(baseSp), cases };
}

async function childMain(name: string): Promise<void> {
  const nm = (await import("node:module")) as unknown as { registerHooks?: (hooks: unknown) => unknown };
  if (typeof nm.registerHooks !== "function") throw new Error("node:module.registerHooks недоступен — нужен Node ≥ 22.15");
  const stubEngine = name === "route-schema";
  const stubSrc =
    `export async function buildCached(q, i) { return globalThis[${JSON.stringify(STUB_KEY)}](q, i); }\n` +
    `export async function rebuild(q, c, i) { return globalThis[${JSON.stringify(STUB_KEY)}](q, i); }\n` +
    `export const isOffline = () => true;\n`;
  const stubUrl = "data:text/javascript," + encodeURIComponent(stubSrc);
  nm.registerHooks({
    resolve(spec: string, ctx: unknown, next: (s: string, c: unknown) => unknown) {
      if (spec === "server-only") return { url: "data:text/javascript,", shortCircuit: true, format: "module" };
      // route.ts импортирует "@/lib/engine" (tsconfig paths); на всякий случай ловим и относительную/абсолютную форму
      if (stubEngine && (spec === "@/lib/engine" || /[\\/]lib[\\/]engine(\.ts)?$/.test(spec))) return { url: stubUrl, shortCircuit: true, format: "module" };
      return next(spec, ctx);
    },
  });
  const out = name === "offline" ? await scenarioOffline()
    : name === "iss500" ? await scenarioIss500()
    : name === "route-schema" ? await scenarioRouteSchema()
    : null;
  if (!out) throw new Error(`неизвестный сценарий: «${name}»`);
  process.stdout.write(MARK + JSON.stringify(out) + "\n");
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

/* ───────────────────────────── родитель: запуск сценария и мемоизация ───────────────────────────── */

const memo = new Map<string, { ok: true; out: unknown } | { ok: false; err: Error }>();
function scenario<T extends { scenario: string }>(name: ScenarioName): T {
  const m = memo.get(name);
  if (m) { if (m.ok) return m.out as T; throw m.err; }
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
    if (name === "iss500") { delete env.SO_OFFLINE; for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k]; }
    else env.SO_OFFLINE = "1"; // offline — по смыслу; route-schema — страховка: движок подменён, но и промах подмены не уйдёт в сеть
    const r = spawnSync(process.execPath, ["--import", "tsx", THIS_FILE, "--scenario", name], {
      cwd: WEB_ROOT, env, encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    const line = String(r.stdout ?? "").split("\n").reverse().find((l) => l.startsWith(MARK));
    if (r.status !== 0 || !line) {
      const tail = String(r.stderr ?? "").trim().split("\n").slice(-8).join(" | ");
      throw new Error(`сценарий ${name}: exit=${r.status} signal=${r.signal ?? "-"}; stderr: ${tail || "(пусто)"}`);
    }
    const out = JSON.parse(line.slice(MARK.length)) as T;
    if (out.scenario !== name) throw new Error(`сценарий ${name}: пришёл результат «${out.scenario}»`);
    memo.set(name, { ok: true, out });
    return out;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    memo.set(name, { ok: false, err });
    throw err;
  }
}
const offline = () => {
  const o = scenario<OfflineOut>("offline");
  if (!o.offline) throw new Error("дочерний процесс не в офлайн-режиме (isOffline()=false) — SO_OFFLINE не дошёл до engine.ts");
  return o;
};
const iss500 = () => {
  const o = scenario<Iss500Out>("iss500");
  if (o.offline) throw new Error("дочерний процесс в офлайн-режиме (isOffline()=true) — fetch-подмена не задействована");
  return o;
};
const routeSchema = () => {
  const o = scenario<RouteSchemaOut>("route-schema");
  if (!o.baseValid) throw new Error(`golden/expected/rolf.json не проходит BondReport (${o.baseIssue}) — база для route-schema непригодна, обновите эталон/контракт`);
  const missed = o.cases.filter((c) => c.stubCalls === 0);
  if (missed.length) throw new Error(`подмена "@/lib/engine" не сработала: route.ts не вызвал заглушку в кейсах ${missed.map((c) => `${c.method} ${c.name}`).join("; ")} (ответы: ${missed.map((c) => `HTTP ${c.status} kind=${c.kind}`).join("; ")})`);
  return o;
};

const fmtSearches = (s: Attempt) => (s.searches.length ? `, поиск q=${s.searches.map((q) => `«${q}»`).join(",")}` : "");
const fmtAttempt = (s: Attempt) =>
  s.resolved
    ? `kind=${s.kind}${s.secid ? ` ${s.secid}` : ""}${s.msg ? ` msg=«${s.msg}»` : ""}, обращений к ISS ${s.fetchCalls}${fmtSearches(s)}, ${s.ms} мс`
    : `ОТКЛОНИЛ промис ${s.errName}(${s.errKind ?? "?"}${s.errStatus != null ? ` ${s.errStatus}` : ""}) «${s.errMsg}», обращений к ISS ${s.fetchCalls} (ретраи), ${s.ms} мс`;

const fmtRoute = (c: RouteCase) =>
  `${c.method} ${c.req} → HTTP ${c.status} kind=${c.kind}` +
  (c.neChislo ? " содержит «не число»" : "") +
  (c.claimLine ? ` claim.line=«${c.claimLine}»` : "") +
  (c.kind === "report" && c.pos != null ? ` position_size=${String(c.pos)}` : "") +
  (c.kind === "report" && c.k != null ? ` k_pct=${String(c.k)}` : "") +
  (c.kind === "report" && c.promised != null ? ` promised_pct=${String(c.promised)}` : "") +
  (c.kind === "report" && c.f12 ? ` flag12=«${c.f12}»` : "") +
  (c.schemaOk === false ? ` BondReport.safeParse: ${c.schemaIssue}` : "");

const fmtSchemaCase = (c: SchemaCase) =>
  `${c.method} ${c.name} → HTTP ${c.status} kind=${c.kind}` +
  (c.msg ? ` msg=«${c.msg}»` : "") +
  (c.kind === "report" ? ` built_at=${c.built_at}${c.built_at === SENTINEL_BUILT_AT ? " (заглушка)" : " (НЕ заглушка)"}` : "") +
  (c.schemaOk === true ? " BondReport ok" : c.schemaOk === false ? ` BondReport НЕ проходит (${c.schemaIssue})` : "");

/* ───────────────────────────── статика исходника (только информационно, в detail) ───────────────────────────── */

/**
 * Снимает // и /* … *\/ комментарии TypeScript, не трогая содержимое строковых литералов ('…', "…", `…`);
 * позиции/номера строк сохраняются (комментарии заменяются пробелами). #-комментариев в TS нет (#x — приватное поле), они не снимаются.
 * Не распознаёт regex-литералы (кавычка внутри /…/ может сдвинуть разбор до конца строки) и вложенные шаблонные строки
 * внутри ${…} другого шаблона. В route.ts сейчас ни того, ни другого нет.
 */
function stripTsComments(src: string): string {
  let out = "";
  const n = src.length;
  for (let i = 0; i < n;) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { let j = i; while (j < n && src[j] !== "\n") j++; out += " ".repeat(j - i); i = j; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (c === "\"" || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j++; else if (c !== "`" && src[j] === "\n") break; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
const lineAt = (src: string, idx: number) => src.slice(0, idx).split("\n").length;
const lineOf = (src: string, needle: string) => { const i = src.indexOf(needle); return i < 0 ? "нет" : `строка ${lineAt(src, i)}`; };

/** Где в route.ts (без комментариев) валидируется конверт/отчёт и где отдаётся Response.json — только подсказка исполнителю. */
function routeSchemaStatic(): string {
  const src = stripTsComments(readSrc(ROUTE_SRC));
  const parses = [...src.matchAll(/\b(BondReport|BuildResult)\s*\.\s*(safeParse|parse)\s*\(/g)].map((m) => ({ at: m.index ?? 0, what: `${m[1]}.${m[2]}(` }));
  const jsons = [...src.matchAll(/Response\.json\s*\(/g)].map((m) => m.index ?? 0);
  const jsonLines = jsons.map((i) => lineAt(src, i)).join(",");
  if (!parses.length) return `исходник route.ts (без комментариев): BondReport/BuildResult.safeParse|parse не найдено, Response.json( на строках ${jsonLines || "—"} отдаёт результат buildCached как есть`;
  const lastJson = jsons.length ? Math.max(...jsons) : -1;
  const before = parses.some((p) => p.at < lastJson);
  return `исходник route.ts (без комментариев): ${parses.map((p) => `${p.what} строка ${lineAt(src, p.at)}`).join(", ")}; Response.json( на строках ${jsonLines || "—"}${before ? "" : " — все вызовы Response.json РАНЬШЕ валидации"}` +
    " (распознаются только эти два имени схем и два метода; валидация в хелпере другого файла не видна — решает поведение)";
}

/** Подсказка исполнителю R.7-web: как сейчас разбирается ввод в route.ts (без комментариев). */
function routeInputsStatic(): string {
  const src = stripTsComments(readSrc(ROUTE_SRC));
  const guard = /\bNumber\.isFinite\s*\(|\bisFinite\s*\(|\.finite\s*\(\)|\binputsSchema\b|\bz\.number\s*\(|\bz\.coerce\b/.test(src);
  return guard
    ? "исходник route.ts: признак валидации ввода есть (isFinite/.finite()/inputsSchema/z.number/z.coerce)"
    : `исходник route.ts: валидации ввода нет — GET: Number(v.replace(",", ".")) (${lineOf(src, "Number(v.replace")}), POST: body.inputs ?? {} как есть (${lineOf(src, "body.inputs")})`;
}

/* ───────────────────────────── проверки ───────────────────────────── */

export const checks: Check[] = [
  {
    id: "R.6-web", wp: "R", kind: "unit",
    title: "buildCached: HTTP 500 от ISS → {kind:\"err\"} без исключения и без записи ошибки в кэш",
    run: (): Verdict => {
      const { step1: s1, step2: s2 } = iss500();
      // та же проверка текста, что в движковой R.6: msg называет источник (Мосбиржа/биржа/ISS как слово)
      const s1ok = s1.resolved && s1.kind === "err" && /мосбирж|бирж|\bISS\b/i.test(s1.msg ?? "");
      const s2ok = s2.resolved && s2.kind === "report" && s2.fetchCalls > 0;
      const d1 = `шаг 1 (fetch→500 на всё): ${fmtAttempt(s1)}` + (s1.resolved && s1.kind === "err" && !s1ok ? " — msg не называет источник (Мосбиржа/биржа/ISS)" : "") + (!s1.resolved ? " — ожидалось {kind:\"err\", msg:\"Мосбиржа не отвечает…\"}" : "");
      const d2 = `шаг 2 (fetch→снимок ISS, тот же запрос ${ISIN}): ${fmtAttempt(s2)}` +
        (s2.resolved ? (s2.fetchCalls > 0 ? " — сбой не закэширован" : " — ВЕРНУЛСЯ КЭШ без обращения к ISS (ошибка легла в кэш на 15 мин)") : "");
      return expect(s1ok && s2ok, `${d1}; ${d2}`);
    },
  },
  {
    id: "R.6-web-guard", wp: "R", kind: "unit", guard: true,
    title: "buildCached: удачный отчёт кэшируется — повтор того же запроса не ходит в ISS",
    run: (): Verdict => {
      const { step2: s2, step3: s3 } = iss500();
      const ok = s2.resolved && s2.kind === "report" && s2.secid === ISIN
        && s3.resolved && s3.kind === "report" && s3.fetchCalls === 0 && s3.built_at === s2.built_at;
      return expect(ok, `сборка: ${fmtAttempt(s2)}, built_at=${s2.built_at}; повтор: ${fmtAttempt(s3)}, built_at=${s3.built_at}${s3.built_at === s2.built_at ? " (тот же)" : " (ДРУГОЙ — пересборка)"}`);
    },
  },
  {
    id: "R.7-web", wp: "R", kind: "fixture",
    title: "/api/report: NaN и значения вне диапазонов inputsSchema → {kind:\"err\"} HTTP 4xx, в ответе нет «не число»",
    run: (): Verdict => {
      const bad = offline().routes.filter((c) => !c.valid);
      const failed = bad.filter((c) => !(c.kind === "err" && c.status >= 400 && c.status < 500 && !c.neChislo));
      return expect(
        bad.length > 0 && failed.length === 0,
        failed.length
          ? `${failed.length}/${bad.length} невалидных запросов приняты как отчёт: ${failed.map(fmtRoute).join(" · ")}; ${routeInputsStatic()}`
          : `все ${bad.length} невалидных запросов отклонены: ${bad.map(fmtRoute).join(" · ")}`,
      );
    },
  },
  {
    id: "R.7-web-guard", wp: "R", kind: "fixture", guard: true,
    title: `/api/report: валидный ввод (promised 26, pos ${POS} ≠ дефолт, k 0,3) → отчёт, ввод применён в GET и POST, схема BondReport проходит`,
    run: (): Verdict => {
      const o = offline();
      const good = o.routes.filter((c) => c.valid);
      const get = good.find((c) => c.method === "GET"), post = good.find((c) => c.method === "POST");
      const posDistinct = o.positionDefault == null || o.positionDefault !== POS;
      const ok = !!get && !!post && posDistinct
        && get.status === 200 && get.kind === "report" && get.promised === 26 && get.pos === POS && get.k === 0.3 && !get.neChislo && get.schemaOk === true
        && post.status === 200 && post.kind === "report" && post.promised === 26 && post.pos === POS && !post.neChislo && post.schemaOk === true;
      return expect(
        ok,
        good.map(fmtRoute).join(" · ") +
          ` · schemaOk GET=${String(get?.schemaOk)} POST=${String(post?.schemaOk)}` +
          ` · CONFIG.positionDefault=${String(o.positionDefault)}${posDistinct ? "" : " — СОВПАДАЕТ с проверочным pos, потеря ввода была бы не видна"}`,
      );
    },
  },
  {
    id: "R.7-web-schema", wp: "R", kind: "fixture",
    title: "/api/report: отчёт от buildCached, не проходящий BondReport (импорт @/lib/engine подменён заглушкой) → {kind:\"err\"}, а не испорченный отчёт; валидный отчёт отдаётся как есть (HTTP-статус для err планом не задан — не утверждается)",
    run: (): Verdict => {
      const o = routeSchema();
      const valid = o.cases.filter((c) => c.corrupt === null);
      const bad = o.cases.filter((c) => c.corrupt !== null);
      const validOk = valid.length > 0 && valid.every((c) => c.status === 200 && c.kind === "report" && c.built_at === SENTINEL_BUILT_AT && c.schemaOk === true);
      const leaked = bad.filter((c) => c.kind !== "err");
      const ok = validOk && bad.length > 0 && leaked.length === 0;
      const dValid = `валидный: ${valid.map(fmtSchemaCase).join(" · ")}${validOk ? "" : " — ВАЛИДНЫЙ ОТЧЁТ НЕ ПРОШЁЛ (ожидался HTTP 200 kind=report с built_at заглушки)"}`;
      const dBad = leaked.length
        ? `испорченные: ${leaked.length}/${bad.length} отданы клиенту как отчёт: ${leaked.map(fmtSchemaCase).join(" · ")}`
        : `испорченные: все ${bad.length} отклонены как err: ${bad.map(fmtSchemaCase).join(" · ")}`;
      const boundary = "граница: подменён импорт \"@/lib/engine\" в route.ts — валидация, сделанная внутри buildCached/engine.ts, а не в маршруте, этой проверке не видна (план кладёт BondReport.safeParse в /api/report)";
      return expect(ok, `${dValid}; ${dBad}; ${routeSchemaStatic()}; ${boundary}`);
    },
  },
  {
    id: "R.8", wp: "R", kind: "unit",
    title: "buildCached (онлайн-путь build()): «RU000A10ASE2» и «РОЛЬФ 1Р07» → один built_at (кэш по SECID, бумага не собирается дважды)",
    run: (): Verdict => {
      const { step2: s2, step4: s4, gapMs24 } = iss500();
      if (!s2.resolved || s2.kind !== "report") return fail(`шаг 2 («${ISIN}») не отчёт: ${fmtAttempt(s2)}`);
      if (!s4.resolved || s4.kind !== "report") return fail(`шаг 4 («${SHORTNAME}») не отчёт: ${fmtAttempt(s4)} — вторая форма записи не резолвится на снимке поиска`);
      const same = s4.built_at === s2.built_at;
      return expect(
        same,
        same
          ? `«${ISIN}» → built_at=${s2.built_at}; «${SHORTNAME}» → ${s4.secid}, тот же built_at (${fmtAttempt(s4)})`
          : `«${ISIN}» → built_at=${s2.built_at} (${s2.fetchCalls} обращений к ISS); «${SHORTNAME}» → ${s4.secid}, built_at=${s4.built_at} (Δ ${gapMs24} мс; ${fmtAttempt(s4)}): одна бумага ${s2.secid}=${s4.secid} собрана дважды с повторным сбором фактов — ключ кэша строится из текста запроса (engine.ts keyOf: query.trim().toLowerCase()|offer), а не из SECID`,
      );
    },
  },
  {
    id: "R.8-offline", wp: "R", kind: "fixture",
    title: "buildCached (SO_OFFLINE=1): «RU000A10ASE2» и «РОЛЬФ 1Р07» → один built_at (кэш по SECID)",
    run: (): Verdict => {
      const { a, b, gapMs } = offline();
      if (a.kind !== "report" || b.kind !== "report") return fail(`не отчёт: «${ISIN}» → ${a.kind}${a.msg ? ` «${a.msg}»` : ""}, «${SHORTNAME}» → ${b.kind}${b.msg ? ` «${b.msg}»` : ""}`);
      const same = a.built_at === b.built_at;
      return expect(
        same,
        same
          ? `«${ISIN}» и «${SHORTNAME}» → ${a.secid}, один built_at=${a.built_at}`
          : `«${ISIN}» → built_at=${a.built_at}, «${SHORTNAME}» → built_at=${b.built_at} (Δ ${gapMs} мс): одна бумага ${a.secid}=${b.secid} собрана дважды — ключ кэша строится из текста запроса (engine.ts keyOf: query.trim().toLowerCase()|offer), а не из SECID; офлайн-ветвь канонизирует запрос в snap.query, но ключ считается до неё`,
      );
    },
  },
  {
    id: "R.8-guard", wp: "R", kind: "unit", guard: true,
    title: "обе формы записи резолвятся в RU000A10ASE2 офлайн и онлайн (онлайн — поиск ISS по названию: полной строкой «РОЛЬФ 1Р07» или её токеном); повтор того же текста отдаёт кэш (один built_at)",
    run: (): Verdict => {
      const { a, b, c } = offline();
      const { step4: s4 } = iss500();
      const offOk = a.kind === "report" && b.kind === "report" && c.kind === "report"
        && a.secid === ISIN && b.secid === ISIN && c.secid === ISIN && a.built_at === c.built_at;
      // Инвариант, а не форма запроса: состоялся поиск по НАЗВАНИЮ — q целиком или токеном/подстрокой «РОЛЬФ 1Р07»
      // (план WP-R разрешает искать по токенам); сравнение без регистра, пробелов и знаков, как norm() в recognize.ts.
      const norm = (t: string) => t.toLowerCase().replace(/[^a-zа-яё0-9]/gi, "");
      const nameSearched = s4.searches.some((q) => norm(q).length > 0 && norm(SHORTNAME).includes(norm(q)));
      const onOk = s4.resolved && s4.kind === "report" && s4.secid === ISIN && nameSearched;
      const dOff = offOk
        ? `офлайн: «${ISIN}» → ${a.secid} (status ${a.status}, main ${a.main}); «${SHORTNAME}» → ${b.secid}; повтор «${ISIN}» built_at=${c.built_at} = первому (кэш по тексту работает)`
        : `офлайн: a=${a.kind}/${a.secid}/${a.built_at}, b=${b.kind}/${b.secid}/${b.built_at}, c=${c.kind}/${c.secid}/${c.built_at}`;
      const resolvedNoSearch = s4.resolved && s4.kind === "report" && s4.secid === ISIN && s4.searches.length === 0;
      const dOn = `онлайн: «${SHORTNAME}» → ${fmtAttempt(s4)}` +
        (onOk ? ""
          : resolvedNoSearch
            ? " — отчёт получен БЕЗ единого поиска ISS (резолв названия из кэша/алиаса — планом WP-R не предусмотрено; если такая правка принята, условие guard о поиске по названию надо пересмотреть)"
            : s4.resolved && s4.kind === "report" && s4.secid === ISIN && !nameSearched
              ? " — отчёт получен, но ни один поиск ISS не является строкой/токеном «РОЛЬФ 1Р07»"
              : " — ожидался отчёт RU000A10ASE2 через поиск ISS по названию (q = «РОЛЬФ 1Р07» целиком или её токен)");
      return expect(offOk && onOk, `${dOff}; ${dOn}`);
    },
  },
];
