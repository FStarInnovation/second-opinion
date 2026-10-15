/**
 * WP-TG, группа «parity» — сценарии ДОЧЕРНЕГО процесса для apps/web/audit/tg/checks-parity.ts (TG.4, TG.5, TG.9, TG.20, TG.21).
 * Запуск только из родителя: `scenario("parity:<name>")` (scenarios.ts) — cwd = apps/web, окружение §6 «Как устроен»
 * (SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0, ключи LLM/Jev сняты, свой временный SO_USAGE_DIR, SO_USAGE_LOG=1,
 * SO_BOT_KEY = TG_TEST.botKey, SO_DAILY_BUDGET_USD=2, SO_MESSAGE_LIMIT снят), "server-only" → пустой модуль, внешний fetch бросает.
 *
 * Сценарии (имя → что делает; результат — JSON для родителя, судит проверка):
 *   dialogs — ядро бота (createCore + FakeTg + fetch → route.POST) проигрывает действия 7 диалогов эталона: каждый POST бота
 *             перехватывается обёрткой fetch (заголовки и тело как их видит сервер, индекс действия); после каждого диалога —
 *             peek ядра и состояние серверной сессии бота. Журнал бота: сырые LogRec, строки makeLogger (если есть log.ts) и всё,
 *             что ушло в console во время ходов; usage.jsonl — снимок после прогона бота. Затем 15 тел браузера повторяются через
 *             route.POST (заголовки и тела эталона) — состояние серверных сессий браузера (TG.4, TG.5, TG.9 — d1, TG.20);
 *   tg9     — renderTurn на 8 сообщениях ассистента из фикстур; два рукописных SSE-потока (OpenRouter: text-end после
 *             tool-input-available; Anthropic: text-end до tool-input-start) через фейковый fetch без route (TG.9);
 *   tg21    — TTL сессии сервера (session.ts с подменой Date.now) и сессии бота: формат id, /new, новое ядро с той же солью,
 *             истечение через deps.now (TG.21).
 *
 * Модули WP-TG грузятся только tryImport по вычисляемому пути от корня `process.env[PARITY_ROOT_ENV] || REPO_ROOT` (подмена
 * корня — только для самопроверки харнеса эталонными модулями вне репозитория). Нет модуля → результат `{missing: detail}`,
 * сервер при этом не грузится; проверка превращает это в RED «нет модуля …; ожидаемо до шага N».
 */
import crypto from "node:crypto";
import path from "node:path";
import type { UIMessage } from "ai";
import { REPO_ROOT } from "../lib";
import { DIALOG_IDS, NAME_MARKERS, UpdateFactory, chatIdOf, lastUserText, loadDialog, playDialog, type RawUpdate } from "./actions";
import { FakeTg, type TgCall } from "./fake-tg";
import { sseResponse } from "./normalize";
import { loadServer, readUsageRaw, testBotConfig, testRandom, TG_TEST } from "./scenarios";
import {
  BOT, PRESENT, loadAll, tryImport,
  type BotMods, type ChatBody, type InlineKeyboard, type Loaded, type LogRec, type PresentMods, type WireMessage,
} from "./types";

/* ═══════════════════════════ общие константы (их же читает родитель) ═══════════════════════════ */

/** Переменная окружения ребёнка: другой корень для модулей WP-TG (только самопроверка харнеса) */
export const PARITY_ROOT_ENV = "SO_AUDIT_TG_PARITY_ROOT";
/** Тексты модели в рукописных SSE TG.9: «A» — до инструмента, «B» — после отчёта */
export const TG9_A = "Сначала найду бумагу на Мосбирже.";
export const TG9_B = "Готово — отчёт выше. Напишите сумму или комиссию, пересчитаю.";
export const TG9_CALL = "call_tg9_resolve";
export const TG9_QUERY = "ОФЗ 26238";
/** chat_id тестов TG.9 и TG.21 (длинные отличимые, как в TG.20) */
export const TG9_CHAT = 7000000209;
export const TG21_CHAT = 7000000221;
/** Начало часов TG.21 (deps.now): 15.10.2026 */
export const TG21_T0 = 1_760_500_000_000;
/** Ответ сервера в TG.21 (фейковый fetch) */
export const TG21_REPLY = "Принято.";

/** Выход инструмента отчёта для рукописного SSE: ответ на тело 1 d1 (ОФЗ 26238, отчёт), как его записал браузер */
export function tg9ReportOutput(): unknown {
  const m = loadDialog("d1").requests[1].body.messages[1];
  const p = m.parts.find((x) => x.type === "tool-resolve_security");
  if (!p || p.output === undefined) throw new Error("дефект харнеса: в d1 (тело 2) нет tool-resolve_security с output");
  return p.output;
}

/**
 * Рукописный UI-поток TG.9 (§6, таблица TG.9). openrouter: `start → start-step → text-start/text-delta(A) →
 * tool-input-start/tool-input-available(resolve_security) → text-end → tool-output-available(report) → finish-step → start-step →
 * text-start/delta(B)/text-end → finish-step → finish`; anthropic — то же, но text-end до tool-input-start.
 */
export function tg9Chunks(variant: "openrouter" | "anthropic", output: unknown): Record<string, unknown>[] {
  const head = [{ type: "start", messageId: `msg-tg9-${variant}` }, { type: "start-step" }, { type: "text-start", id: "txt-a" }, { type: "text-delta", id: "txt-a", delta: TG9_A }];
  const toolIn = [
    { type: "tool-input-start", toolCallId: TG9_CALL, toolName: "resolve_security" },
    { type: "tool-input-available", toolCallId: TG9_CALL, toolName: "resolve_security", input: { query: TG9_QUERY } },
  ];
  const textEnd = { type: "text-end", id: "txt-a" };
  const tail = [
    { type: "tool-output-available", toolCallId: TG9_CALL, output },
    { type: "finish-step" }, { type: "start-step" },
    { type: "text-start", id: "txt-b" }, { type: "text-delta", id: "txt-b", delta: TG9_B }, { type: "text-end", id: "txt-b" },
    { type: "finish-step" }, { type: "finish" },
  ];
  return variant === "openrouter" ? [...head, ...toolIn, textEnd, ...tail] : [...head, textEnd, ...toolIn, ...tail];
}

/** Простой ответ сервера для TG.21: одна text-часть */
export const tg21Chunks = (): Record<string, unknown>[] => [
  { type: "start" }, { type: "start-step" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: TG21_REPLY },
  { type: "text-end", id: "t" }, { type: "finish-step" }, { type: "finish" },
];

/** Псевдоним по формуле §4.4: base64url(HMAC-SHA256(salt, String(chatId))).slice(0, 12) — независимо от ids.ts */
export const pseudonymFormula = (chatId: number, salt: string): string =>
  crypto.createHmac("sha256", salt).update(String(chatId)).digest("base64url").slice(0, 12);

/* ═══════════════════════════ мелочи ═══════════════════════════ */

const modRoot = () => process.env[PARITY_ROOT_ENV] || REPO_ROOT;
function loadBotMod<K extends keyof BotMods>(k: K, need?: readonly string[]): Promise<Loaded<BotMods[K]>> {
  const s = BOT[k];
  return tryImport<BotMods[K]>(path.join(modRoot(), s.rel), s.step, { need: need ?? s.need });
}
function loadPresentMod<K extends keyof PresentMods>(k: K, need?: readonly string[]): Promise<Loaded<PresentMods[K]>> {
  const s = PRESENT[k];
  return tryImport<PresentMods[K]>(path.join(modRoot(), s.rel), s.step, { need: need ?? s.need });
}
const errStr = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, " ").slice(0, 400);
const safeJson = (v: unknown): string => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };

/** Вызов FakeTg в JSON (ошибка — строкой) */
export interface CallJ {
  seq: number; method: string; chatId?: number; messageId?: number; text?: string; html?: boolean; keyboard?: InlineKeyboard;
  callbackId?: string; error?: string;
}
const callJ = (c: TgCall): CallJ => {
  const base: CallJ = { seq: c.seq, method: c.method };
  if (c.error) base.error = `${c.error.name}${(c.error as { error_code?: number }).error_code != null ? ` ${(c.error as { error_code?: number }).error_code}` : ""}: ${c.error.message}`;
  switch (c.method) {
    case "sendMessage": return { ...base, chatId: c.chatId, text: c.text, html: !!c.opts?.html, keyboard: c.opts?.keyboard, ...(c.messageId != null ? { messageId: c.messageId } : {}) };
    case "editMessageText": return { ...base, chatId: c.chatId, messageId: c.messageId, text: c.text, html: !!c.opts?.html, keyboard: c.opts?.keyboard };
    case "answerCallbackQuery": return { ...base, callbackId: c.callbackId, ...(c.text !== undefined ? { text: c.text } : {}) };
    case "sendChatAction": return { ...base, chatId: c.chatId };
  }
};

/** Запрос бота в сервер, как его видит сервер (заголовки — имена в нижнем регистре) */
export interface BotReq {
  dialog: string; step: number; url: string; method: string; headers: Record<string, string>; rawBody: string;
  status: number; error: string | null;
}
/** Обёртка fetch бота: каждый вызов записывается ДО передачи серверу (даже если маршрут бросит) */
function recordingFetch(target: typeof fetch, sink: BotReq[], tag: () => { dialog: string; step: number }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request && init === undefined ? input : new Request(input, init);
    const rawBody = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const rec: BotReq = { ...tag(), url: req.url, method: req.method, headers, rawBody, status: 0, error: null };
    sink.push(rec);
    try {
      const res = await target(req);
      rec.status = res.status;
      return res;
    } catch (e) {
      rec.error = errStr(e);
      throw e;
    }
  }) as typeof fetch;
}
const isChatPost = (r: { method: string; url: string }) => {
  try { return r.method === "POST" && new URL(r.url).pathname === "/api/chat"; } catch { return false; }
};
const bodyOf = (raw: string): ChatBody | null => { try { return JSON.parse(raw) as ChatBody; } catch { return null; } };

/* ═══════════════════════════ состояние серверной сессии (TG.5) ═══════════════════════════ */

export interface SessState { query: string | null; resultKind: string | null; reportInputs: unknown; pendingInputs: unknown; userMessages: number }
type SessionLike = { query: string | null; result: unknown; pendingInputs?: unknown; userMessages: number };
const sessState = (s: SessionLike): SessState => {
  const r = s.result as { kind?: string; report?: { inputs?: unknown } } | null;
  return {
    query: s.query ?? null,
    resultKind: r?.kind ?? null,
    reportInputs: r?.kind === "report" ? (r.report?.inputs ?? null) : null,
    pendingInputs: s.pendingInputs ?? null,
    userMessages: s.userMessages,
  };
};

/* ═══════════════════════════ dialogs: TG.4, TG.5, TG.9 (d1), TG.20 ═══════════════════════════ */

export interface DialogRun {
  dialog: string; chatId: number;
  playOk: boolean; playDetail: string | null;
  /** шаги: индекс действия, пометка (что отправлено в бот), диапазон вызовов FakeTg, диапазон запросов бота */
  steps: { action: number; note: string; callsFrom: number; callsTo: number; reqFrom: number; reqTo: number; ms: number }[];
  peek: { sessionId: string; messages: number; inputs: unknown } | null;
  peekError: string | null;
  /** id серверной сессии бота: peek.sessionId, иначе body.id последнего POST */
  botSid: string | null;
  bot: SessState | null;
  /** повтор тел браузера */
  browserSid: string;
  browser: SessState;
  browserStatus: number[];
}
export interface DialogsOut {
  missing: string | null;
  runs: DialogRun[];
  /** все запросы бота через fetch (не только /api/chat) */
  requests: BotReq[];
  calls: CallJ[];
  log: { recs: string[]; lines: string[] | null; logMissing: string | null; console: string[] };
  /** usage.jsonl сразу после прогона бота (до повтора тел браузера) — только записи ходов бота */
  usageBot: string;
  pseudonyms: { chatId: number; mod: string | null; formula: string }[];
  idsMissing: string | null;
  /** сырые апдейты, которые получило ядро: всего, с маркерами имён во from/chat, с chat.id = from.id */
  updates: { total: number; withMarkers: number; chatEqFrom: number; chatIds: number[] };
  /** тексты реплик пользователя: тексты апдейтов и последние реплики пользователя в телах бота */
  userTexts: string[];
  ms: number;
  /** uncaughtException ребёнка за время сценария */
  uncaught?: string[];
}

async function dialogs(): Promise<DialogsOut> {
  const t0 = Date.now();
  const empty: DialogsOut = {
    missing: null, runs: [], requests: [], calls: [], log: { recs: [], lines: null, logMissing: null, console: [] }, usageBot: "",
    pseudonyms: [], idsMissing: null, updates: { total: 0, withMarkers: 0, chatEqFrom: 0, chatIds: [] }, userTexts: [], ms: 0,
  };
  const m = await loadAll({ core: () => loadBotMod("core"), entry: () => loadPresentMod("entry") });
  if (!m.ok) return { ...empty, missing: m.detail, ms: Date.now() - t0 };
  const { core: coreMod, entry } = m.mods;
  const logL = await loadBotMod("log");
  const idsL = await loadBotMod("ids", ["pseudonymOf"]);

  const srv = await loadServer();
  const tg = new FakeTg();
  const factory = new UpdateFactory();
  const recs: string[] = [];
  const lines: string[] = [];
  const logger = logL.ok ? logL.mod.makeLogger((l: string) => { lines.push(String(l)); }, [TG_TEST.token, TG_TEST.botKey, TG_TEST.salt]) : null;
  const log = (r: LogRec) => {
    recs.push(safeJson(r));
    if (logger) try { logger(r); } catch (e) { lines.push(`(makeLogger бросил: ${errStr(e)})`); }
  };
  const requests: BotReq[] = [];
  const tag = { dialog: "", step: -1 };
  const botFetch = recordingFetch(srv.fetch, requests, () => ({ ...tag }));
  const core = coreMod.createCore({ config: testBotConfig(), tg, fetch: botFetch, random: testRandom(), log });

  // всё, что ушло в console/stdout/stderr во время ходов бота, — тоже журнал (на проде stdout и stderr бота = journalctl, §7).
  // Сервер в ребёнке при SO_QUIET=1 в консоль не пишет, так что чужих строк здесь нет; строка MARK пишется после возврата run().
  const consoleOut: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map((k) => console[k]);
  methods.forEach((k) => { console[k] = (...a: unknown[]) => { consoleOut.push(a.map((x) => (typeof x === "string" ? x : safeJson(x))).join(" ")); }; });
  const streams = [process.stdout, process.stderr] as const;
  const savedW = streams.map((st) => st.write);
  streams.forEach((st) => {
    st.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
      const str = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
      for (const l of str.split("\n")) if (l.trim()) consoleOut.push(l);
      const done = typeof enc === "function" ? enc : typeof cb === "function" ? cb : null;
      if (done) (done as () => void)();
      return true;
    }) as typeof st.write;
  });

  const runs: DialogRun[] = [];
  const updates: RawUpdate[] = [];
  try {
    for (const id of DIALOG_IDS) {
      const d = loadDialog(id);
      const chatId = chatIdOf(d);
      tag.dialog = id;
      const steps: DialogRun["steps"] = [];
      let reqMark = requests.length;
      tag.step = 0;
      const play = await playDialog(core, tg, d, {
        chatId, entry, factory,
        afterStep: (s) => {
          updates.push(s.update);
          steps.push({ action: s.action, note: s.note, callsFrom: s.callsFrom, callsTo: s.callsTo, reqFrom: reqMark, reqTo: requests.length, ms: s.ms });
          reqMark = requests.length;
          tag.step = s.action + 1;
        },
      });
      let peek: DialogRun["peek"] = null;
      let peekError: string | null = null;
      try {
        const p = core.peek(chatId);
        if (p) peek = { sessionId: String(p.sessionId), messages: Array.isArray(p.messages) ? p.messages.length : -1, inputs: p.inputs ?? null };
      } catch (e) { peekError = errStr(e); }
      const mine = requests.filter((r) => r.dialog === id && isChatPost(r));
      const lastId = mine.length ? bodyOf(mine[mine.length - 1].rawBody)?.id ?? null : null;
      const botSid = peek?.sessionId ?? (lastId != null ? String(lastId) : null);
      runs.push({
        dialog: id, chatId, playOk: play.ok, playDetail: play.detail ?? null, steps, peek, peekError, botSid,
        bot: botSid ? sessState(srv.session.getSession(botSid)) : null,
        browserSid: String(d.requests[0].body.id ?? ""), browser: { query: null, resultKind: null, reportInputs: null, pendingInputs: null, userMessages: 0 }, browserStatus: [],
      });
    }
  } finally {
    methods.forEach((k, i) => { console[k] = saved[i]; });
    streams.forEach((st, i) => { st.write = savedW[i]; });
  }
  const usageBot = readUsageRaw();

  // повтор тел браузера (заголовки и тела эталона) — эталон состояния серверной сессии
  for (const run of runs) {
    const d = loadDialog(run.dialog);
    for (const r of d.requests) {
      try {
        const res = await srv.postRecorded(r);
        await res.text();
        run.browserStatus.push(res.status);
      } catch (e) {
        run.browserStatus.push(0);
        void e;
      }
    }
    run.browser = sessState(srv.session.getSession(run.browserSid));
  }

  const chatIds = runs.map((r) => r.chatId);
  const userTexts = new Set<string>();
  for (const u of updates) if (u.message?.text) userTexts.add(u.message.text);
  for (const r of requests) { const b = bodyOf(r.rawBody); if (b) { const t = lastUserText(b as Parameters<typeof lastUserText>[0]); if (t) userTexts.add(t); } }
  const hasMarkers = (x: unknown) => { const s = safeJson(x); return Object.values(NAME_MARKERS).every((v) => s.includes(v)); };
  return {
    missing: null, runs, requests, calls: tg.calls.map(callJ),
    log: { recs, lines: logger ? lines : null, logMissing: logL.ok ? null : logL.detail, console: consoleOut },
    usageBot,
    pseudonyms: chatIds.map((c) => {
      let mod: string | null = null;
      if (idsL.ok) try { mod = String(idsL.mod.pseudonymOf(c, TG_TEST.salt)); } catch { mod = null; }
      return { chatId: c, mod, formula: pseudonymFormula(c, TG_TEST.salt) };
    }),
    idsMissing: idsL.ok ? null : idsL.detail,
    updates: {
      total: updates.length,
      withMarkers: updates.filter((u) => (u.message ? hasMarkers(u.message.from) && hasMarkers(u.message.chat) : u.callback_query ? hasMarkers(u.callback_query.from) && hasMarkers(u.callback_query.message?.chat) : false)).length,
      chatEqFrom: updates.filter((u) => (u.message ? u.message.chat.id === u.message.from?.id : u.callback_query ? u.callback_query.message?.chat.id === u.callback_query.from.id : false)).length,
      chatIds,
    },
    userTexts: [...userTexts],
    ms: Date.now() - t0,
  };
}

/* ═══════════════════════════ tg9: порядок ═══════════════════════════ */

export interface OpJ { partIndex: number; toolCallId: string | null; html: boolean; text: string; buttons: number }
export interface Tg9Render {
  dialog: string; messageId: string;
  parts: { type: string; state: string | null; toolCallId: string | null; text: string | null; found: boolean | null }[];
  ops: OpJ[] | null; error: string | null;
}
export interface Tg9Sse { variant: "openrouter" | "anthropic"; posts: number; calls: CallJ[]; summary: string; error: string | null }
export interface Tg9Out { missing: string | null; waitReport: string; render: Tg9Render[]; sse: Tg9Sse[]; uncaught?: string[] }

/** Все сообщения ассистента из тел эталона (без повторов по id), по порядку диалогов */
export function fixtureAssistants(): { dialog: string; message: WireMessage }[] {
  const out: { dialog: string; message: WireMessage }[] = [];
  const seen = new Set<string>();
  for (const id of DIALOG_IDS)
    for (const r of loadDialog(id).requests)
      for (const msg of r.body.messages)
        if (msg.role === "assistant" && !seen.has(String(msg.id))) { seen.add(String(msg.id)); out.push({ dialog: id, message: msg }); }
  return out;
}

async function tg9(): Promise<Tg9Out> {
  const m = await loadAll({
    render: () => loadBotMod("render", ["renderTurn"]), core: () => loadBotMod("core"),
    copy: () => loadPresentMod("copy", ["WAIT_REPORT"]), protocol: () => loadPresentMod("protocol", ["CABINET_HREF"]),
  });
  if (!m.ok) return { missing: m.detail, waitReport: "", render: [], sse: [] };
  const { render, core: coreMod, copy, protocol } = m.mods;

  const renderOut: Tg9Render[] = fixtureAssistants().map(({ dialog, message }) => {
    const parts = message.parts.map((p) => ({
      type: p.type, state: typeof p.state === "string" ? p.state : null, toolCallId: typeof p.toolCallId === "string" ? p.toolCallId : null,
      text: p.type === "text" ? String(p.text ?? "") : null,
      found: p.type === "tool-explain_term" && p.output && typeof p.output === "object" ? (p.output as { found?: boolean }).found === true : null,
    }));
    try {
      const ops = render.renderTurn(JSON.parse(JSON.stringify(message)) as UIMessage, { cabinetHref: protocol.CABINET_HREF });
      return {
        dialog, messageId: String(message.id), parts, error: null,
        ops: (Array.isArray(ops) ? ops : []).map((o) => ({
          partIndex: o.partIndex, toolCallId: o.toolCallId ?? null, html: !!o.html, text: String(o.text ?? ""),
          buttons: o.keyboard?.inline_keyboard?.flat().length ?? 0,
        })),
      };
    } catch (e) {
      return { dialog, messageId: String(message.id), parts, ops: null, error: errStr(e) };
    }
  });

  const output = tg9ReportOutput();
  const sse: Tg9Sse[] = [];
  for (const variant of ["openrouter", "anthropic"] as const) {
    const tg = new FakeTg();
    let posts = 0;
    const fakeFetch = (async () => { posts++; return sseResponse(tg9Chunks(variant, output), { delayMs: 2 }); }) as unknown as typeof fetch;
    let error: string | null = null;
    try {
      const core = coreMod.createCore({ config: testBotConfig(), tg, fetch: fakeFetch, random: testRandom(0x7909), log: () => {} });
      const u: RawUpdate = new UpdateFactory().message(TG9_CHAT, TG9_QUERY);
      await core.handleUpdate(u);
      await core.idle();
    } catch (e) { error = errStr(e); }
    sse.push({ variant, posts, calls: tg.calls.map(callJ), summary: tg.summary(0, 50), error });
  }
  return { missing: null, waitReport: String(copy.WAIT_REPORT), render: renderOut, sse };
}

/* ═══════════════════════════ tg21: сессия ═══════════════════════════ */

export interface Tg21Post { sid: string | null; xChat: string | null; messages: number; lastUser: string }
export interface Tg21Step {
  label: string; core: "A" | "B"; text: string; t: number;
  posts: Tg21Post[]; calls: CallJ[]; peek: { sessionId: string; messages: number } | null; error: string | null;
}
export interface Tg21Out {
  /** session.ts с подменой Date.now: сессия жива при простое SESSION_TTL_MS − 1 с и вытеснена после SESSION_TTL_MS + 1 с */
  session: { ttl: number; keptBefore: boolean; goneAfter: boolean } | { skipped: string } | { error: string };
  missing: string | null;
  ttl: number; margin: number; sessionExpired: string;
  steps: Tg21Step[];
  pseudo: { mod: string | null; formula: string };
  uncaught?: string[];
}

async function tg21(): Promise<Tg21Out> {
  const out: Tg21Out = { session: { skipped: "" }, missing: null, ttl: 0, margin: 0, sessionExpired: "", steps: [], pseudo: { mod: null, formula: pseudonymFormula(TG21_CHAT, TG_TEST.salt) } };
  const protoL = await loadPresentMod("protocol", ["SESSION_TTL_MS", "BOT_TTL_MARGIN_MS"]);
  const sessL = await tryImport<{ getSession(id: string): unknown }>(path.join(modRoot(), "apps/web/lib/session.ts"), 2, { need: ["getSession"] });
  if (!protoL.ok) out.session = { skipped: protoL.detail };
  else if (!sessL.ok) out.session = { skipped: sessL.detail };
  else {
    const T = Number(protoL.mod.SESSION_TTL_MS);
    const realNow = Date.now;
    let t = realNow();
    Date.now = () => t;
    try {
      const a = sessL.mod.getSession("tg21-ttl-a");
      t += T - 1000;
      sessL.mod.getSession("tg21-ttl-probe");
      const keptBefore = sessL.mod.getSession("tg21-ttl-a") === a; // касание: простой «a» снова 0
      t += T + 1000;
      const goneAfter = sessL.mod.getSession("tg21-ttl-a") !== a;
      out.session = { ttl: T, keptBefore, goneAfter };
    } catch (e) {
      out.session = { error: errStr(e) };
    } finally {
      Date.now = realNow;
    }
  }

  const m = await loadAll({
    core: () => loadBotMod("core"), ids: () => loadBotMod("ids", ["pseudonymOf"]),
    protocol: () => loadPresentMod("protocol", ["SESSION_TTL_MS", "BOT_TTL_MARGIN_MS"]), copy: () => loadPresentMod("copy", ["BOT"]),
  });
  if (!m.ok) { out.missing = m.detail; return out; }
  const { core: coreMod, ids, protocol, copy } = m.mods;
  out.ttl = Number(protocol.SESSION_TTL_MS);
  out.margin = Number(protocol.BOT_TTL_MARGIN_MS);
  out.sessionExpired = String(copy.BOT?.sessionExpired ?? "");
  try { out.pseudo.mod = String(ids.pseudonymOf(TG21_CHAT, TG_TEST.salt)); } catch { out.pseudo.mod = null; }
  const life = out.ttl - out.margin;

  let t = TG21_T0;
  const now = () => t;
  const posts: Tg21Post[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request && init === undefined ? input : new Request(input, init);
    const b = bodyOf(await req.text());
    posts.push({ sid: b?.id != null ? String(b.id) : null, xChat: req.headers.get("x-so-chat"), messages: Array.isArray(b?.messages) ? b.messages.length : -1, lastUser: b ? lastUserText(b as Parameters<typeof lastUserText>[0]) : "" });
    return sseResponse(tg21Chunks());
  }) as typeof fetch;
  const factory = new UpdateFactory({ firstUpdateId: 700_000_001 });
  const mk = (tg: FakeTg, seed: number) => coreMod.createCore({ config: testBotConfig(), tg, fetch: fakeFetch, now, random: testRandom(seed), log: () => {} });
  const tgA = new FakeTg();
  const tgB = new FakeTg();
  let coreA: ReturnType<typeof mk> | null = null;
  let coreB: ReturnType<typeof mk> | null = null;
  const step = async (label: string, which: "A" | "B", text: string) => {
    const tg = which === "A" ? tgA : tgB;
    const from = tg.calls.length;
    const p0 = posts.length;
    let error: string | null = null;
    let peek: Tg21Step["peek"] = null;
    try {
      const core = which === "A" ? (coreA ??= mk(tgA, 0x2101)) : (coreB ??= mk(tgB, 0x2102));
      const u: RawUpdate = factory.message(TG21_CHAT, text);
      await core.handleUpdate(u);
      await core.idle();
      const p = core.peek(TG21_CHAT);
      if (p) peek = { sessionId: String(p.sessionId), messages: Array.isArray(p.messages) ? p.messages.length : -1 };
    } catch (e) { error = errStr(e); }
    out.steps.push({ label, core: which, text, t: t - TG21_T0, posts: posts.slice(p0), calls: tg.calls.slice(from).map(callJ), peek, error });
  };
  await step("first", "A", "Привет");
  t += life - 1000;
  await step("beforeTtl", "A", "Что такое дюрация?");
  t += life + 1000;
  await step("afterTtl", "A", "а купон?");
  t += 1000;
  await step("new", "A", "/new");
  t += 1000;
  await step("afterNew", "A", "Черкизово");
  t += 1000;
  await step("newCore", "B", "Привет");
  return out;
}

/* ═══════════════════════════ вход ═══════════════════════════ */

/** Исключения из таймеров ядра (uncaughtException) не роняют ребёнка: пишутся в результат, проверка их показывает */
const uncaught: string[] = [];
let guarded = false;
function guardUncaught(): void {
  if (guarded) return;
  guarded = true;
  process.on("uncaughtException", (e) => { uncaught.push(errStr(e)); });
}

export async function run(name: string): Promise<unknown> {
  const fn = name === "dialogs" ? dialogs : name === "tg9" ? tg9 : name === "tg21" ? tg21 : null;
  if (!fn) return undefined;
  guardUncaught();
  const out = await fn();
  return { ...out, uncaught: [...uncaught] };
}
