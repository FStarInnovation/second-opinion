/**
 * WP-TG: сценарии с сервером — ДОЧЕРНИЙ процесс, как wp-u-gate.ts:353. Причина: lib/engine.ts фиксирует SO_OFFLINE при импорте
 * и ищет golden от cwd; budget.ts / usage-log.ts / session.ts фиксируют каталог журнала, бюджет и лимит при импорте.
 *   node --import tsx apps/web/audit/tg/scenarios.ts --scenario <replay|bot|limits|inputs|misc>   (cwd = apps/web)
 * Окружение задаёт родитель (wp-tg.ts): SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0, ключи LLM и Jev сняты, SO_USAGE_DIR — свой
 * временный каталог на сценарий, SO_USAGE_LOG=1, SO_BOT_KEY — тестовое значение; в misc ещё SO_BUILD_SHA = TEST_BUILD_SHA (sha сборки
 * для /api/health, TG.23). "server-only" → пустой модуль (registerHooks).
 * globalThis.fetch бросает на любой URL (офлайн-сборка сеть не использует). route.POST вызывается как функция; бот получает
 * fetch = (url, init) => route.POST(new Request(url, init)) — только для http://127.0.0.1:3000/api/chat (и /api/health).
 * Ответ сервера собирается функциями ai@7 (parseJsonEventStream + uiMessageChunkSchema + readUIMessageStream) — это тот же
 * processUIMessageStream, что работает под assistant-ui в браузере (эталонный сборщик; его привязка к браузеру — TG.G2).
 * Результат — одна строка MARK + JSON в stdout. Сценарий не падает из-за кода продукта: каждый вызов в try/catch, ошибка — в данных.
 * Только в misc: импорт @so/engine/inputs из lib/engine.ts перенаправлен на top3-shim.ts — второй прогон TG.14 с переставленным
 * top3 (на реальных golden top3 совпадает с сортировкой по баллам, и без перестановки проверка не отличает гейт со своей сортировкой).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BuildResultT, ReportInputs } from "@so/engine/contract";
import { REPO_ROOT } from "../lib";
import { callbackButtons, callbackUpdate, loadDialogs, messageUpdate, parseAction, testUser, type TestUser } from "./actions";
import { fakeTelegram, type TgCall } from "./fake-tg";
import { loadCopy, loadCore, loadEntry, loadLog, loadProtocol, loadVersion, type BotConfig, type BotCore, type UIMsg } from "./mods";

export const MARK = "@@WP-TG@@";
/** Тестовые секреты: ключ бота (SO_BOT_KEY сервера), соль псевдонимов, токен Bot API (формат как у настоящего, значение — нет) */
export const TEST_KEY = "audit-bot-key-7f3c9a1e5b2d4c6f8a0b1c2d3e4f5a6b";
export const TEST_SALT = "audit-salt-4e8d2c6a9b1f3e5d7c0a2b4c6d8e0f1a";
export const TEST_TOKEN = "123456789:AAHauditTOKENauditTOKENauditTOKEN12345";
export const WEB_URL = "http://127.0.0.1:3000";
/** TG.23: sha сборки, который родитель передаёт сценарию misc в SO_BUILD_SHA (в проде его подставляет next build из VERSION),
 *  и sha «кода на диске» во временном VERSION для readVersion бота — значения разные намеренно */
export const TEST_BUILD_SHA = "a1b2c3d";
export const TEST_DISK_SHA = "e4f5a6b";
/** Реплика, которую гейт закрывает шаблоном без модели и без отчёта (прямая просьба о совете) */
export const CHEAP_TEXT = "предложи ты бумагу";

const THIS_FILE = fileURLToPath(import.meta.url);
const NET = { blocked: [] as string[] };
const errMsg = (e: unknown) => String(e instanceof Error ? `${e.name}: ${e.message}` : e).replace(/\s+/g, " ").slice(0, 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: не завершилось за ${ms} мс`)), ms); })]);
  } finally { if (t) clearTimeout(t); }
}
const urlOf = (input: unknown) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? input);

/* ───────────── общие типы результата ───────────── */
export interface SessState { query: string | null; resultKind: string | null; inputs: unknown; pendingInputs: unknown; userMessages: number }
export interface PostOut { status: number | null; msg: UIMsg | null; text: string; error?: string }
export interface DialogRun { name: string; sessionId: string; reqs: PostOut[]; state: SessState | null }
export type UsageRec = Record<string, unknown>;
export interface ReplayOut {
  web: DialogRun[]; tg: DialogRun[]; usage: UsageRec[];
  synthetic: { messages: number; reports: number; bytes: number; status: number | null; error?: string };
}
export interface PostRec { url: string; headers: Record<string, string>; body: unknown; status: number | null }
export interface BotAct { action: string; tgFrom: number; tgTo: number; postFrom: number; postTo: number; error?: string }
export interface BotDialog { name: string; user: TestUser; acts: BotAct[]; peek: { sessionId: string; messages: number } | null; state: SessState | null }
export interface BotOut {
  missing: string | null; entryMissing: string | null; dialogs: BotDialog[]; posts: PostRec[]; tgCalls: TgCall[];
  logLines: string[]; loggerFromBot: boolean; usage: UsageRec[];
}
export interface KeyCase { name: string; id: string; expect: number; status: number | null; error?: string; userMessages: number; budgetDelta: number; channels: unknown[] }
export interface LimitsOut {
  messageLimit: number; budgetLimit: number; exhausted: boolean;
  key: KeyCase[];
  webLimit: PostOut[]; tgLimit: PostOut[]; webBudget: PostOut; tgBudget: PostOut;
  copy: { ok: true; limitTg: string; budgetTg: string; limitWeb: string; budgetWeb: string } | { ok: false; why: string };
}
export type Verdict3 = "accept" | "reject" | "?";
export interface InputCell { v: Verdict3 | null; note: string }
export interface InputRow { name: string; field: string; valid: boolean; cells: Record<string, InputCell> }
export interface InputsOut {
  contractHas: boolean; toolsSame: boolean | null; contractKeys: string[]; rows: InputRow[]; entryMissing: string | null;
}
export interface Top3Row {
  name: string; text: string; handled: boolean; status: string | null; top3: string[]; byPoints: string[]; gate: string[] | null; none: boolean; error?: string;
}
export interface MiscOut {
  top3: Top3Row[];
  /** Тот же прогон гейта, но top3 собранного отчёта переставлен (top3-shim.ts): порядок top3 ≠ сортировке по баллам */
  top3Perm: Top3Row[]; permNote: string | null;
  health: {
    local: unknown; external: unknown; error?: string;
    /** SO_BUILD_SHA процесса сценария (задаёт родитель) и содержимое <repo>/VERSION, если файл есть (справочно: сервер его читать не должен) */
    buildSha: string | null; versionFile: string | null;
    /** Бот: readVersion на каталоге с VERSION (TEST_DISK_SHA) и без него; checkServerVersion против этого /api/health со своим и чужим sha */
    bot: {
      missing: string | null; withFile: string | null; noFile: string | null;
      same: { ok: boolean; server: string | null } | string | null; other: { ok: boolean; server: string | null } | string | null;
    };
  };
  ttl: { protoMissing: string | null; ttl: number | null; aliveBefore: boolean | null; expiredAfter: boolean | null };
}

/* ───────────── сервер в процессе ───────────── */
type RouteMod = typeof import("../../app/api/chat/route");
type SessionMod = typeof import("../../lib/session");
type ChatSession = import("../../lib/session").ChatSession;

async function server() {
  const budget = await import("../../lib/budget");
  const usage = await import("../../lib/usage-log");
  const session = await import("../../lib/session");
  const route = await import("../../app/api/chat/route");
  const dir = process.env.SO_USAGE_DIR ?? "";
  if (!dir || !usage.usageFile().startsWith(dir)) throw new Error(`дефект харнеса: usage-log пишет в ${usage.usageFile()}, а не в SO_USAGE_DIR=${dir}`);
  return { budget, usage, session, route, dir };
}

/** Ответ /api/chat → UIMessage, собранный ai (тот же processUIMessageStream, что в браузере) */
async function assemble(res: Response): Promise<{ msg: UIMsg | null; error?: string }> {
  if (!res.body) return { msg: null, error: "нет тела ответа" };
  const ai = await import("ai");
  type Parsed = { success: boolean; value?: unknown; error?: unknown };
  try {
    const parsed = ai.parseJsonEventStream({ stream: res.body, schema: ai.uiMessageChunkSchema }) as unknown as ReadableStream<Parsed>;
    const chunks = parsed.pipeThrough(new TransformStream<Parsed, unknown>({
      transform(c, ctl) { if (!c.success) throw c.error; ctl.enqueue(c.value); },
    }));
    let last: UIMsg | null = null;
    for await (const m of ai.readUIMessageStream({ stream: chunks as ReadableStream<import("ai").UIMessageChunk>, terminateOnError: true })) last = m as unknown as UIMsg;
    return { msg: last ? (JSON.parse(JSON.stringify(last)) as UIMsg) : null };
  } catch (e) { return { msg: null, error: `сборка потока: ${errMsg(e)}` }; }
}
const textOf = (m: UIMsg | null) =>
  (m?.parts ?? []).filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join(" ").replace(/\s+/g, " ").trim();

async function post(route: RouteMod, headers: Record<string, string>, body: unknown): Promise<PostOut> {
  try {
    const res = await route.POST(new Request(`${WEB_URL}/api/chat`, { method: "POST", headers, body: JSON.stringify(body) }));
    if (res.status !== 200) { await res.text().catch(() => ""); return { status: res.status, msg: null, text: "" }; }
    const a = await assemble(res);
    return { status: res.status, msg: a.msg, text: textOf(a.msg), ...(a.error ? { error: a.error } : {}) };
  } catch (e) { return { status: null, msg: null, text: "", error: `исключение до ответа: ${errMsg(e)}` }; }
}
const st = (s: ChatSession): SessState => ({
  query: s.query, resultKind: s.result?.kind ?? null, inputs: s.result?.kind === "report" ? s.result.report.inputs : null,
  pendingInputs: s.pendingInputs ?? null, userMessages: s.userMessages,
});
function readUsage(file: string): UsageRec[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as UsageRec]; } catch { return []; } });
}
const rnd = (n = 6) => crypto.randomBytes(n).toString("base64url");
/** id в формате бота tg_<12>_<8> */
const tgId = (tag: string) => `tg_${(tag + "xxxxxxxxxxxx").slice(0, 12).replace(/[^A-Za-z0-9_-]/g, "x")}_${rnd(6)}`;
const browserUser = (text: string) => ({ role: "user", parts: [{ type: "text", text }], metadata: { custom: {} }, id: rnd(12) });
const browserBody = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ tools: {}, ...extra, id, messages: [browserUser(text)], trigger: "submit-message", metadata: {} });
const webHeaders = (chat: string) => ({ "content-type": "application/json", "x-so-chat": chat });
const botHeaders = (id: string, key = TEST_KEY) => ({ "content-type": "application/json", "x-so-chat": id, "x-so-channel": "telegram", "x-so-bot-key": key });

/* ═════════════ replay: 15 тел браузера как есть (G2, G6, TG.5-веб) и те же тела как бот (TG.3) ═════════════ */
async function scReplay(): Promise<ReplayOut> {
  const { route, session, usage } = await server();
  const dialogs = loadDialogs();
  const web: DialogRun[] = [];
  for (const d of dialogs) {
    const reqs: PostOut[] = [];
    for (const r of d.requests) reqs.push(await post(route, r.headers, r.body));
    const sid = String(d.requests[0].body.id);
    web.push({ name: d.name, sessionId: sid, reqs, state: st(session.getSession(sid)) });
  }
  const tg: DialogRun[] = [];
  for (const [i, d] of dialogs.entries()) {
    const tid = tgId(`replay${i}`);
    const reqs: PostOut[] = [];
    for (const r of d.requests) reqs.push(await post(route, botHeaders(tid), { ...r.body, id: tid }));
    tg.push({ name: d.name, sessionId: tid, reqs, state: st(session.getSession(tid)) });
  }
  // G6: синтетическая история — 10 пар «реплика + отчёт» (сообщение ассистента с отчётом из d1, как его записал браузер) и новая реплика
  const d1 = dialogs.find((d) => d.name === "d1-main");
  const rep = d1?.requests[1]?.body.messages?.[1];
  let synthetic: ReplayOut["synthetic"];
  if (!rep) synthetic = { messages: 0, reports: 0, bytes: 0, status: null, error: "нет сообщения с отчётом в d1-main (requests[1].messages[1])" };
  else {
    const messages: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(browserUser("Проверь РОЛЬФ 1Р07, обещали 26%"));
      const a = JSON.parse(JSON.stringify(rep)) as UIMsg;
      a.id = rnd(12);
      for (const p of a.parts) if (typeof p.toolCallId === "string") p.toolCallId = `gate_syn${i}`;
      messages.push(a);
    }
    messages.push(browserUser(CHEAP_TEXT));
    const body = { tools: {}, id: "__LOCALID_auditG6", messages, trigger: "submit-message", metadata: {} };
    const r = await post(route, webHeaders("c_auditg6"), body);
    synthetic = { messages: messages.length, reports: 10, bytes: Buffer.byteLength(JSON.stringify(body)), status: r.status, ...(r.error ? { error: r.error } : {}) };
  }
  await sleep(50); // onEnd-колбэки журнала
  return { web, tg, usage: readUsage(usage.usageFile()), synthetic };
}

/* ═════════════ bot: createCore + фейковый Telegram + fetch → route.POST на действиях 7 диалогов (TG.4, TG.5, TG.9, TG.20) ═════════════ */
const headersOf = (h: unknown): Record<string, string> => {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries([...h.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  if (Array.isArray(h)) return Object.fromEntries((h as [string, string][]).map(([k, v]) => [k.toLowerCase(), v]));
  return Object.fromEntries(Object.entries(h as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
};

async function scBot(): Promise<BotOut> {
  const { route, session, usage } = await server();
  const empty: BotOut = { missing: null, entryMissing: null, dialogs: [], posts: [], tgCalls: [], logLines: [], loggerFromBot: false, usage: [] };
  const core = await loadCore();
  if (!core.ok) return { ...empty, missing: core.why };
  const entry = await loadEntry();
  const logm = await loadLog();
  const health = await import("../../app/api/health/route");
  const tg = fakeTelegram();
  const posts: PostRec[] = [];
  const logLines: string[] = [];
  const log = logm.ok
    ? logm.mod.makeLogger((l) => logLines.push(l), [TEST_TOKEN, TEST_KEY, TEST_SALT])
    : (r: unknown) => { logLines.push(JSON.stringify(r)); };
  const botFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const u = new URL(url);
    if (u.origin === WEB_URL && u.pathname === "/api/chat") {
      const req = input instanceof Request ? new Request(input, init) : new Request(url, init);
      const raw = await req.clone().text();
      let body: unknown = raw;
      try { body = JSON.parse(raw); } catch { /* не JSON — сравнится как строка */ }
      const rec: PostRec = { url, headers: headersOf(init?.headers ?? (input instanceof Request ? input.headers : undefined)), body, status: null };
      posts.push(rec);
      const res = await route.POST(req);
      rec.status = res.status;
      return res;
    }
    if (u.origin === WEB_URL && u.pathname === "/api/health")
      return health.GET(new Request(url, { headers: { host: "127.0.0.1:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "127.0.0.1:3000" } }));
    NET.blocked.push(url);
    throw new Error(`аудит WP-TG: бот обратился к ${url} — разрешены только ${WEB_URL}/api/chat и /api/health`);
  }) as typeof fetch;
  const config: BotConfig = {
    webUrl: WEB_URL, botKey: TEST_KEY, salt: TEST_SALT, allow: "*", dailyTurns: 1000, concurrency: 4, perChatPending: 2,
    maxChats: 300, turnTimeoutMs: 90_000,
  };
  let clock = Date.parse("2026-10-14T09:00:00.000Z");
  let c: BotCore;
  try {
    c = core.mod.createCore({
      config, tg: tg.client, fetch: botFetch, now: () => clock, random: (n) => new Uint8Array(crypto.randomBytes(n)),
      sleep: async () => {}, log,
    });
  } catch (e) { return { ...empty, missing: `createCore бросил исключение: ${errMsg(e)}` }; }
  const dialogs = loadDialogs();
  const out: BotDialog[] = [];
  for (const [i, d] of dialogs.entries()) {
    const user = testUser(i);
    const acts: BotAct[] = [];
    for (const raw of d.actions) {
      const a = parseAction(raw);
      const before = { tg: tg.calls.length, posts: posts.length };
      let upd: ReturnType<typeof messageUpdate> | null = null;
      let error: string | undefined;
      if (a.kind === "type" || a.kind === "open-m") upd = messageUpdate(user, a.text);
      else if (a.kind === "open-q") {
        if (!entry.ok) error = entry.why;
        else {
          const p = entry.mod.encodeStartPayload(a.params);
          if (!p) error = `encodeStartPayload(${JSON.stringify(a.params)}) вернул null`;
          else upd = messageUpdate(user, `/start ${p}`);
        }
      } else {
        const kbs = tg.keyboards(user.chatId);
        const last = kbs[kbs.length - 1];
        const b = last ? callbackButtons(last.keyboard)[a.i] : undefined;
        if (!last) error = "в чате нет сообщения бота с клавиатурой";
        else if (!b?.callback_data) error = `у последнего сообщения с клавиатурой нет кнопки №${a.i} с callback_data`;
        else upd = callbackUpdate(user, b.callback_data, last.messageId);
      }
      if (upd) {
        try {
          await within(c.handleUpdate(upd), 60_000, "handleUpdate");
          await within(c.idle(), 60_000, "idle");
        } catch (e) { error = errMsg(e); }
      }
      clock += 7_000;
      acts.push({ action: raw, tgFrom: before.tg, tgTo: tg.calls.length, postFrom: before.posts, postTo: posts.length, ...(error ? { error } : {}) });
    }
    let pk: ReturnType<typeof c.peek> | undefined;
    try { pk = c.peek(user.chatId); } catch { pk = undefined; }
    out.push({
      name: d.name, user, acts,
      peek: pk ? { sessionId: pk.sessionId, messages: pk.messages.length } : null,
      state: pk ? st(session.getSession(pk.sessionId)) : null,
    });
  }
  await sleep(50);
  return {
    missing: null, entryMissing: entry.ok ? null : entry.why, dialogs: out, posts, tgCalls: tg.calls, logLines,
    loggerFromBot: logm.ok, usage: readUsage(usage.usageFile()),
  };
}

/* ═════════════ limits: ключ бота и 403 (TG.11), тексты лимита и бюджета по каналу (G1, TG.12) ═════════════ */
async function scLimits(): Promise<LimitsOut> {
  const { route, session, budget, usage, dir } = await server();
  const copyM = await loadCopy();
  const usageOf = (id: string) => readUsage(usage.usageFile()).filter((r) => r.chat === id && (r.step === "gate" || r.step === "answer"));
  const wrongKey = TEST_KEY.slice(0, -1) + (TEST_KEY.endsWith("0") ? "1" : "0");
  type C = { name: string; id: string; headers: Record<string, string>; expect: number; serverKey?: string };
  const mk = (name: string, expect: number, f: (id: string) => Record<string, string>, id = tgId("key"), serverKey?: string): C =>
    ({ name, id, headers: f(id), expect, ...(serverKey !== undefined ? { serverKey } : {}) });
  const cases: C[] = [
    mk("(a) id tg_… без заголовков бота", 403, (id) => webHeaders(id)),
    mk("(b) id tg_… + x-so-channel: telegram, без ключа", 403, (id) => ({ ...webHeaders(id), "x-so-channel": "telegram" })),
    mk("(c) id tg_… + канал + неверный ключ той же длины", 403, (id) => botHeaders(id, wrongKey)),
    mk("(d) канал + верный ключ, id без tg_", 403, (id) => botHeaders(id), `__LOCALID_audit${rnd(4)}`),
    mk("(d2) id tg_… + верный ключ, без x-so-channel", 403, (id) => ({ ...webHeaders(id), "x-so-bot-key": TEST_KEY })),
    mk("(h) SO_BOT_KEY на сервере пуст, запрос бота с ключом", 403, (id) => botHeaders(id), tgId("key"), ""),
    mk("(h2) SO_BOT_KEY на сервере пуст, ключ в запросе пуст", 403, (id) => botHeaders(id, ""), tgId("key"), ""),
    mk("(e) всё верно: tg_ + канал + ключ", 200, (id) => botHeaders(id)),
    mk("(f) тело браузера", 200, () => webHeaders(`c_${rnd(5)}`), `__LOCALID_audit${rnd(4)}`),
  ];
  const key: KeyCase[] = [];
  for (const c of cases) {
    const saved = process.env.SO_BOT_KEY;
    if (c.serverKey !== undefined) process.env.SO_BOT_KEY = c.serverKey;
    const m0 = budget.budgetState().messages;
    const r = await post(route, c.headers, browserBody(c.id, CHEAP_TEXT));
    if (c.serverKey !== undefined) process.env.SO_BOT_KEY = saved;
    await sleep(30);
    key.push({
      name: c.name, id: c.id, expect: c.expect, status: r.status, ...(r.error ? { error: r.error } : {}),
      userMessages: session.getSession(c.id).userMessages, budgetDelta: budget.budgetState().messages - m0,
      channels: usageOf(c.id).map((x) => x.channel),
    });
  }
  // лимит сообщений сессии (SO_MESSAGE_LIMIT=2 задан родителем): третий ход
  const webLimit: PostOut[] = [];
  const wid = `__LOCALID_auditLim${rnd(3)}`;
  for (let i = 0; i < 3; i++) webLimit.push(await post(route, webHeaders(`c_lim${rnd(3)}`), browserBody(wid, CHEAP_TEXT)));
  const tgLimit: PostOut[] = [];
  const tid = tgId("limit");
  for (let i = 0; i < 3; i++) tgLimit.push(await post(route, botHeaders(tid), browserBody(tid, CHEAP_TEXT)));
  // бюджет исчерпан: budget.json текущих суток МСК с расходом выше SO_DAILY_BUDGET_USD (=1, задан родителем)
  fs.writeFileSync(path.join(dir, "budget.json"), JSON.stringify({ day: budget.mskDay(), spent: 5, messages: 0 }));
  const exhausted = budget.budgetState().exhausted;
  const webBudget = await post(route, webHeaders(`c_bud${rnd(3)}`), browserBody(`__LOCALID_auditBud${rnd(3)}`, CHEAP_TEXT));
  const bid = tgId("budget");
  const tgBudget = await post(route, botHeaders(bid), browserBody(bid, CHEAP_TEXT));
  const copy: LimitsOut["copy"] = copyM.ok
    ? { ok: true, limitTg: copyM.mod.limitText("telegram", session.MESSAGE_LIMIT), budgetTg: copyM.mod.budgetExhaustedText("telegram"),
      limitWeb: copyM.mod.limitText("web", session.MESSAGE_LIMIT), budgetWeb: copyM.mod.budgetExhaustedText("web") }
    : { ok: false, why: copyM.why };
  return { messageLimit: session.MESSAGE_LIMIT, budgetLimit: budget.DAILY_BUDGET_USD, exhausted, key, webLimit, tgLimit, webBudget, tgBudget, copy };
}

/* ═════════════ inputs: одна схема ввода у всех потребителей (TG.13) ═════════════ */
export interface InputCase { name: string; field: "position_size" | "k_pct" | "promised_pct" | "offer_price_pct"; js: number; url: string; json: unknown; deep: string; valid: boolean }
export const INPUT_Q = "RU000A1038V6"; // ОФЗ 26238 — golden ofz26238, офлайн-снимок
export const PARAM: Record<InputCase["field"], "pos" | "k" | "promised" | "price"> = { position_size: "pos", k_pct: "k", promised_pct: "promised", offer_price_pct: "price" };
/** Таблица значений: NaN (в URL и JSON — «abc»), позиция 999, комиссия 3,5, «обещали» 101, цена 0 и 301; плюс валидные */
export const INPUT_CASES: InputCase[] = [
  { name: "pos NaN («abc»)", field: "position_size", js: NaN, url: "abc", json: "abc", deep: "_sabc", valid: false },
  { name: "pos 999", field: "position_size", js: 999, url: "999", json: 999, deep: "_s999", valid: false },
  { name: "k 3,5", field: "k_pct", js: 3.5, url: "3,5", json: 3.5, deep: "_k350", valid: false },
  { name: "promised 101", field: "promised_pct", js: 101, url: "101", json: 101, deep: "_p10100", valid: false },
  { name: "price 0", field: "offer_price_pct", js: 0, url: "0", json: 0, deep: "_o0", valid: false },
  { name: "price 301", field: "offer_price_pct", js: 301, url: "301", json: 301, deep: "_o30100", valid: false },
  { name: "pos 1 000 000", field: "position_size", js: 1_000_000, url: "1000000", json: 1_000_000, deep: "_s1000000", valid: true },
  { name: "k 0,3", field: "k_pct", js: 0.3, url: "0.3", json: 0.3, deep: "_k30", valid: true },
  { name: "promised 15", field: "promised_pct", js: 15, url: "15", json: 15, deep: "_p1500", valid: true },
  { name: "price 98,5", field: "offer_price_pct", js: 98.5, url: "98.5", json: 98.5, deep: "_o9850", valid: true },
];

async function scInputs(): Promise<InputsOut> {
  const contract = (await import("@so/engine/contract")) as unknown as Record<string, unknown>;
  const schema = contract.ReportInputsSchema as { safeParse(x: unknown): { success: boolean } } | undefined;
  const tools = await import("../../lib/tools");
  const reportRoute = await import("../../app/api/report/route");
  const page = await import("../../app/check/page");
  const { route, session } = await server();
  const entry = await loadEntry();
  const rows: InputRow[] = [];
  const eq = (a: unknown, b: number) => typeof a === "number" && a === b;
  for (const c of INPUT_CASES) {
    const cells: Record<string, InputCell> = {};
    const one = { [c.field]: c.js };
    cells.schema = schema ? { v: schema.safeParse(one).success ? "accept" : "reject", note: "" } : { v: null, note: "нет ReportInputsSchema в @so/engine/contract" };
    // /api/report GET и POST: принято = 200 + отчёт с этим значением; отклонено = 4xx + {kind:"err"}
    const reportCell = async (res: Response): Promise<InputCell> => {
      const j = (await res.json().catch(() => null)) as { kind?: string; report?: { inputs?: Record<string, unknown> }; msg?: string } | null;
      const got = j?.report?.inputs?.[c.field];
      if (res.status === 200 && j?.kind === "report" && eq(got, c.js)) return { v: "accept", note: `200 report, ${c.field}=${JSON.stringify(got)}` };
      if (res.status >= 400 && res.status < 500 && j?.kind === "err") return { v: "reject", note: `${res.status} err` };
      return { v: "?", note: `${res.status} ${j?.kind ?? "не JSON"}${j?.kind === "report" ? `, ${c.field}=${JSON.stringify(got)}` : ""}${j?.msg ? ` «${j.msg}»` : ""}` };
    };
    try {
      cells.reportGet = await reportCell(await reportRoute.GET(new Request(`${WEB_URL}/api/report?q=${INPUT_Q}&${PARAM[c.field]}=${encodeURIComponent(c.url)}`)));
    } catch (e) { cells.reportGet = { v: "?", note: `исключение: ${errMsg(e)}` }; }
    try {
      cells.reportPost = await reportCell(await reportRoute.POST(new Request(`${WEB_URL}/api/report`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: INPUT_Q, inputs: { [c.field]: c.json } }),
      })));
    } catch (e) { cells.reportPost = { v: "?", note: `исключение: ${errMsg(e)}` }; }
    // /api/chat body.inputs: принято = в pendingInputs сессии это значение; невалидное игнорируется (200, не 400)
    {
      const sid = `__LOCALID_auditIn${rnd(4)}`;
      const r = await post(route, webHeaders(`c_in${rnd(3)}`), browserBody(sid, CHEAP_TEXT, { inputs: { [c.field]: c.json } }));
      const pend = session.getSession(sid).pendingInputs as Record<string, unknown> | null | undefined;
      cells.chatInputs = r.status !== 200 ? { v: "?", note: `status ${r.status}${r.error ? ` ${r.error}` : ""}` }
        : eq(pend?.[c.field], c.js) ? { v: "accept", note: `pendingInputs.${c.field}=${JSON.stringify(pend?.[c.field])}` }
        : { v: "reject", note: `pendingInputs=${JSON.stringify(pend ?? null)}` };
    }
    // страница /check: CheckPage() как функция, result в пропсах CheckClient; принято = значение в report.inputs, отклонено = проигнорировано
    try {
      const el = (await page.default({ searchParams: Promise.resolve({ q: INPUT_Q, [PARAM[c.field]]: c.url }) })) as unknown as { props?: { result?: BuildResultT } };
      const res = el?.props?.result;
      const got = res?.kind === "report" ? (res.report.inputs as unknown as Record<string, unknown>)[c.field] : undefined;
      cells.checkPage = res?.kind !== "report" ? { v: "?", note: `result.kind=${res?.kind}` }
        : eq(got, c.js) ? { v: "accept", note: `${c.field}=${JSON.stringify(got)}` } : { v: "reject", note: `${c.field}=${JSON.stringify(got)} (проигнорировано)` };
    } catch (e) { cells.checkPage = { v: "?", note: `исключение: ${errMsg(e)}` }; }
    // initialOf (/chat?q=…) и deep-link бота
    if (entry.ok) {
      try {
        const i = entry.mod.initialOf({ q: INPUT_Q, [PARAM[c.field]]: c.url });
        const got = i && "inputs" in i && i.inputs ? (i.inputs as Record<string, unknown>)[c.field] : undefined;
        cells.initialOf = eq(got, c.js) ? { v: "accept", note: "" } : { v: "reject", note: `inputs=${JSON.stringify(i && "inputs" in i ? i.inputs : null)}` };
      } catch (e) { cells.initialOf = { v: "?", note: `исключение: ${errMsg(e)}` }; }
      try {
        const payload = `q${INPUT_Q}${c.deep}`;
        const d = entry.mod.decodeStartPayload(payload);
        const i = d ? entry.mod.initialOf(d) : undefined;
        const got = i && "inputs" in i && i.inputs ? (i.inputs as Record<string, unknown>)[c.field] : undefined;
        cells.deepLink = eq(got, c.js) ? { v: "accept", note: payload } : { v: "reject", note: `${payload} → ${JSON.stringify(d)}` };
      } catch (e) { cells.deepLink = { v: "?", note: `исключение: ${errMsg(e)}` }; }
    } else {
      cells.initialOf = { v: null, note: "нет @so/present/entry" };
      cells.deepLink = { v: null, note: "нет @so/present/entry" };
    }
    rows.push({ name: c.name, field: c.field, valid: c.valid, cells });
  }
  return {
    contractHas: schema != null, toolsSame: schema != null ? (tools.inputsSchema as unknown) === schema : null,
    contractKeys: Object.keys(contract).sort(), rows, entryMissing: entry.ok ? null : entry.why,
  };
}

/* ═════════════ misc: «Главные red flags» = top3 (TG.14), version в /api/health (TG.23), TTL сессии (TG.21) ═════════════ */
async function scMisc(): Promise<MiscOut> {
  const session: SessionMod = await import("../../lib/session");
  // TG.14: гейт на 13 golden-отчётах — реплика проверки с «обещали» из кейса, ответ гейта против truth_score.top3 собранного отчёта
  const gate = await import("../../lib/gate");
  type Writer = Parameters<typeof gate.runGate>[0];
  const cases = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/engine/golden/cases.json"), "utf8")) as { cases: Array<{ name: string; query: string; inputs?: ReportInputs }> }).cases;
  const runTop3 = async (tag: string): Promise<Top3Row[]> => {
    const rows: Top3Row[] = [];
    for (const k of cases) {
      const exp = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, `packages/engine/golden/expected/${k.name}.json`), "utf8")) as BuildResultT;
      if (exp.kind !== "report") continue;
      const promised = k.inputs?.promised_pct;
      const text = `Проверь ${k.query}` + (promised != null ? `, обещали ${String(promised).replace(".", ",")}%` : "");
      const parts: Array<Record<string, unknown>> = [];
      const w = { write: (p: Record<string, unknown>) => { parts.push(p); }, merge: () => {} } as unknown as Writer;
      const s = session.getSession(`audit-tg14-${tag}-${k.name}-${rnd(3)}`);
      try {
        const outc = await gate.runGate(w, s, text, null);
        const said = parts.filter((p) => p.type === "text-delta").map((p) => String(p.delta ?? "")).join("").replace(/\s+/g, " ").trim();
        const r = s.result?.kind === "report" ? s.result.report : null;
        const titles = r ? r.truth_score.top3.map((id) => r.flags.find((f) => f.id === id)?.title ?? `#${id}`) : [];
        const byPoints = r ? r.flags.filter((f) => f.fired).sort((a, b) => b.points - a.points).slice(0, 3).map((f) => f.title) : [];
        const m = said.match(/Главные red flags: ([^.]+)\./);
        rows.push({
          name: k.name, text: said, handled: outc.handled, status: r?.status.kind ?? null, top3: titles, byPoints,
          gate: m ? m[1].split(", ").map((x) => x.trim()) : null, none: /Ни один из red flags не сработал/.test(said),
        });
      } catch (e) { rows.push({ name: k.name, text: "", handled: false, status: null, top3: [], byPoints: [], gate: null, none: false, error: errMsg(e) }); }
    }
    return rows;
  };
  const top3 = await runTop3("nat");
  // Синтетика: top3 переставлен (обратный порядок) обёрткой top3-shim.ts — гейт обязан назвать флаги в порядке top3, а не по баллам
  const g = globalThis as { __soAuditTop3?: (ids: number[]) => number[]; __soAuditShim?: boolean };
  g.__soAuditTop3 = (ids) => ids.reverse();
  let top3Perm: Top3Row[];
  try { top3Perm = await runTop3("perm"); } finally { delete g.__soAuditTop3; }
  const differs = top3Perm.filter((r) => r.top3.length > 1 && r.top3.join("|") !== r.byPoints.join("|")).length;
  const permNote = !g.__soAuditShim
    ? "дефект харнеса: top3-shim.ts не подключился (импорт @so/engine/inputs из lib/engine.ts не перенаправлен)"
    : differs === 0 ? "дефект харнеса: перестановка top3 ни в одном кейсе не отличается от порядка по баллам" : null;
  // TG.23: /api/health локально — version СБОРКИ (process.env.SO_BUILD_SHA; Next подставляет его при next build), снаружи — только {ok}.
  // Родитель задаёт SO_BUILD_SHA = TEST_BUILD_SHA. Файл VERSION (код на диске) сервер читать не должен: иначе после упавшей сборки
  // сверка «файл против файла» совпадает при старом сервере в памяти (§4.3 плана).
  let health: MiscOut["health"];
  {
    const vf = path.join(REPO_ROOT, "VERSION");
    const versionFile = fs.existsSync(vf) ? fs.readFileSync(vf, "utf8").trim() : null;
    const localReq = (url: string) => new Request(url, { headers: {
      host: "127.0.0.1:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "http", "x-forwarded-port": "3000" } });
    let h: typeof import("../../app/api/health/route") | null = null;
    let local: unknown = null, external: unknown = null, error: string | undefined;
    try {
      h = await import("../../app/api/health/route");
      local = await (await h.GET(localReq(`${WEB_URL}/api/health`))).json();
      external = await (await h.GET(new Request("https://mkt-second-opinion.ru/api/health", { headers: {
        host: "mkt-second-opinion.ru", "x-forwarded-for": "203.0.113.7", "x-forwarded-host": "mkt-second-opinion.ru", "x-forwarded-proto": "https", "x-forwarded-port": "3000" } }))).json();
    } catch (e) { error = errMsg(e); }
    // бот: readVersion (свой VERSION во временном каталоге — не в репозитории) и checkServerVersion против этого /api/health
    const vm = await loadVersion();
    const bot: MiscOut["health"]["bot"] = { missing: vm.ok ? null : vm.why, withFile: null, noFile: null, same: null, other: null };
    if (vm.ok) {
      const base = process.env.SO_USAGE_DIR;
      if (!base) throw new Error("дефект харнеса: нет SO_USAGE_DIR — временный VERSION бота негде создать (в репозиторий не пишем)");
      const withDir = fs.mkdtempSync(path.join(base, "ver-"));
      const noDir = fs.mkdtempSync(path.join(base, "nover-"));
      fs.writeFileSync(path.join(withDir, "VERSION"), `${TEST_DISK_SHA}\n`);
      const call = (f: () => string): string => { try { return f(); } catch (e) { return `исключение: ${errMsg(e)}`; } };
      bot.withFile = call(() => vm.mod.readVersion(withDir));
      bot.noFile = call(() => vm.mod.readVersion(noDir));
      if (h) {
        const hh = h;
        const f = (async (input: RequestInfo | URL) => {
          const u = new URL(urlOf(input));
          if (u.origin === WEB_URL && u.pathname === "/api/health") return hh.GET(localReq(u.href));
          throw new Error(`аудит WP-TG: checkServerVersion обратился к ${u.href} — ожидался ${WEB_URL}/api/health`);
        }) as typeof fetch;
        const check = async (mine: string) => {
          try { return await within(vm.mod.checkServerVersion(f, WEB_URL, mine), 5_000, "checkServerVersion"); }
          catch (e) { return `исключение: ${errMsg(e)}`; }
        };
        bot.same = await check(TEST_BUILD_SHA);
        bot.other = await check(TEST_DISK_SHA);
      }
    }
    health = { local, external, error, buildSha: process.env.SO_BUILD_SHA ?? null, versionFile, bot };
  }
  // TG.21 (сервер): сессия живёт ровно SESSION_TTL_MS — часы подменены (процесс отдельный, чужие сессии не задеты)
  let ttl: MiscOut["ttl"];
  {
    const proto = await loadProtocol();
    if (!proto.ok) ttl = { protoMissing: proto.why, ttl: null, aliveBefore: null, expiredAfter: null };
    else {
      const T = proto.mod.SESSION_TTL_MS;
      const real = Date.now;
      let t = real();
      Date.now = () => t;
      try {
        const id = `audit-ttl-${rnd(3)}`;
        session.getSession(id).userMessages = 5;
        t += T - 1_000;
        const aliveBefore = session.getSession(id).userMessages === 5;
        t += T + 1_000;
        const expiredAfter = session.getSession(id).userMessages === 0;
        ttl = { protoMissing: null, ttl: T, aliveBefore, expiredAfter };
      } finally { Date.now = real; }
    }
  }
  return { top3, top3Perm, permNote, health, ttl };
}

const SCENARIOS: Record<string, () => Promise<unknown>> = { replay: scReplay, bot: scBot, limits: scLimits, inputs: scInputs, misc: scMisc };

async function childMain(name: string): Promise<void> {
  const nm = (await import("node:module")) as unknown as { registerHooks?: (hooks: unknown) => unknown };
  if (typeof nm.registerHooks !== "function") throw new Error("node:module.registerHooks недоступен — нужен Node ≥ 22.15");
  // TG.14 (только misc): импорт @so/engine/inputs из lib/engine.ts → top3-shim.ts (без флага __soAuditTop3 — тот же модуль)
  const shim = pathToFileURL(path.join(path.dirname(THIS_FILE), "top3-shim.ts")).href;
  nm.registerHooks({
    resolve(spec: string, ctx: { parentURL?: string }, next: (s: string, c: unknown) => unknown) {
      if (spec === "server-only") return { url: "data:text/javascript,", shortCircuit: true, format: "module" };
      if (name === "misc" && spec === "@so/engine/inputs" && /\/apps\/web\/lib\/engine\.ts$/.test(ctx.parentURL ?? "")) {
        (globalThis as { __soAuditShim?: boolean }).__soAuditShim = true;
        return next(shim, ctx);
      }
      return next(spec, ctx);
    },
  });
  globalThis.fetch = (async (input: unknown) => {
    const u = urlOf(input);
    NET.blocked.push(u);
    throw new Error(`аудит WP-TG: сеть запрещена (fetch ${u.slice(0, 100)})`);
  }) as typeof fetch;
  const fn = SCENARIOS[name];
  if (!fn) throw new Error(`неизвестный сценарий WP-TG: «${name}»`);
  const out = await fn();
  // stdout в pipe на macOS асинхронный: дождаться сброса строки до process.exit
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

export const SCENARIO_FILE = THIS_FILE;
