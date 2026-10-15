/**
 * WP-TG, общая инфраструктура харнеса (docs/PLAN_telegram_bot_2026-10-14.md §4, §6 «Как устроен»).
 *
 * 1. Структурные типы интерфейсов §4: `@so/present/{protocol,entry,copy,report}`, модули `apps/bot/src/*`, `apps/web/lib/channel.ts`.
 *    Модулей пока нет — сигнатуры продублированы здесь, поэтому typecheck @so/web не зависит от их появления. Если сигнатура
 *    в §4 меняется (решение оркестратора), правится и этот файл.
 * 2. Загрузчик `tryImport` — динамический `import(pathToFileURL(абсолютный путь).href)`: статических импортов несуществующих
 *    модулей в харнесе нет. Нет файла → `{ok:false, detail:"нет модуля <rel>; ожидаемо до шага N"}`; файл есть, но импорт
 *    упал (синтаксис, нет зависимости, нет нужного экспорта) → тоже `ok:false`, detail с ошибкой. Проверка превращает это в
 *    `fail(detail)` — RED, а не ERROR.
 * 3. Типы эталона диалогов `apps/web/audit/fixtures/dialogs/dN.json` и «проводные» (как в JSON) сообщения UIMessage.
 *
 * Шаги (§5): 2 = P1 (protocol, entry, copy), 3 = P2 (report), 4 = P3 (channel.ts), 5 = P4 (apps/bot/src/*).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { UIMessage } from "ai";
import type { BondReportT, BuildResultT, PanelIdT, ReportInputs } from "@so/engine/contract";
import { REPO_ROOT } from "../lib";

export type { UIMessage, BondReportT, BuildResultT, PanelIdT, ReportInputs };

/* ═══════════════════════════ эталон диалогов (fixtures/dialogs/dN.json) ═══════════════════════════ */

/** Действие пользователя в браузере: ввод реплики, переход по ссылке /chat?…, кнопка «Проверить» i-го кандидата в pick */
export type DialogAction = { kind: "type"; text: string } | { kind: "open"; url: string } | { kind: "pick"; index: number };

/** Часть сообщения в теле запроса — как её сериализовал браузер (text / step-start / tool-<имя> / …) */
export interface WirePart {
  type: string;
  text?: string;
  state?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  [k: string]: unknown;
}
/** Сообщение в теле POST /api/chat. user: {role, parts, metadata:{custom:{}}, id}; assistant: {id, role, parts} (§4.5) */
export interface WireMessage {
  id?: string;
  role: "user" | "assistant" | "system";
  parts: WirePart[];
  metadata?: unknown;
  [k: string]: unknown;
}
/** Тело POST /api/chat браузера: `{ tools: {}, inputs?, id, messages, trigger: "submit-message", metadata: {} }` */
export interface ChatBody {
  tools?: unknown;
  inputs?: unknown;
  id?: string;
  messages: WireMessage[];
  trigger?: string;
  metadata?: unknown;
  [k: string]: unknown;
}
/** Запрос эталона: action — индекс действия; headers — только content-type и x-* (имена в нижнем регистре) */
export interface RecordedRequest { action: number; headers: Record<string, string>; headerNames: string[]; body: ChatBody }
export interface DialogFixture {
  id: string;
  title: string;
  recorded: { commit: string; date: string; mode: string; browser: string; via: string };
  actions: DialogAction[];
  requests: RecordedRequest[];
}

/* ═══════════════════════════ @so/present (§4.1) ═══════════════════════════ */

export type Channel = "web" | "telegram";

/** @so/present/protocol */
export interface ProtocolMod {
  TOOL_NAMES: readonly string[];
  SESSION_TTL_MS: number;
  BOT_TTL_MARGIN_MS: number;
  HDR: { chat: string; channel: string; botKey: string };
  TG_SESSION_PREFIX: string;
  CABINET_HREF: string;
}

/** Параметры входа: /chat?q=…&promised=…&pos=…&k=…&price=…  или  /chat?m=… (значения — строки, как в URL) */
export type EntryParams = { q?: string; promised?: string; pos?: string; k?: string; price?: string; m?: string };
/** Дословно ChatApp.tsx:10 */
export type ChatInitial = { q: string; inputs: ReportInputs; text?: never } | { text: string; q?: never; inputs?: never };

/** @so/present/entry */
export interface EntryMod {
  initialOf(p: EntryParams): ChatInitial | undefined;
  firstText(i: ChatInitial): string;
  chatParams(res: BuildResultT, query: string): EntryParams | null;
  pickMessage(c: { isin?: string | null; secid: string }): string;
  SUGGESTIONS: readonly string[];
  encodeStartPayload(p: EntryParams): string | null;
  decodeStartPayload(s: string): EntryParams | null;
}

/** BOT из @so/present/copy — все тексты бота */
export interface BotCopy {
  start: string; help: string; privacy: string; newSession: string; sessionExpired: string; busy: string;
  onlyText: string; serviceRestarting: string; turnFailed: string; dailyLimit(n: number): string; notAllowed(code: string): string;
  fullReport: string; openOnSite: string;
}
/** @so/present/copy */
export interface CopyMod {
  WAIT_REPORT: string;
  WAIT_TERM: string;
  DISCLAIMER: string;
  limitText(ch: Channel, limit: number): string;
  budgetExhaustedText(ch: Channel): string;
  BOT: BotCopy;
  WEB: Record<string, string>;
}

export type Tone = "good" | "mid" | "bad" | "none";
export interface SectionVM {
  id: PanelIdT; title: string; subtitle?: string; big?: string; tone?: Tone; lines: string[];
  barsCaption?: string;
  bars?: { label: string; value: string }[];
  items?: { title: string; text: string; badge?: string }[];
}
export interface ReportVM {
  dataTime: string | null; kicker: string; name: string; isin: string | null;
  sections: SectionVM[]; plaque: { title: string; items: string[] } | null;
}
export type BranchVM =
  | { kind: "pick"; title: string; lines: string[];
      options: { label: string; sub: string; reg: string; trading: string; message: string; traded: boolean }[] }
  | { kind: "notfound" | "err"; title: string; lines: string[] };
export type NonReportResult = Exclude<BuildResultT, { kind: "report" }>;

/** @so/present/report */
export interface ReportMod {
  scoreTone(score: number): Tone;
  liquidityTone(cat: string, noExit: boolean): Tone;
  presentReport(r: BondReportT, o?: { askPriceNote?: string }): ReportVM;
  presentBranch(res: NonReportResult): BranchVM;
  vmStrings(vm: ReportVM | BranchVM): string[];
}

/* ═══════════════════════════ apps/web/lib/channel.ts (§4.3) ═══════════════════════════ */

export interface ChannelMod {
  channelOf(req: Request, sessionId: string): { ok: true; channel: Channel } | { ok: false; status: 403 };
}

/* ═══════════════════════════ apps/bot/src/* (§4.4) ═══════════════════════════ */

export interface BotConfig {
  webUrl: string; botKey: string; salt: string; allow: string; dailyTurns: number; concurrency: number;
  perChatPending: number; maxChats: number; turnTimeoutMs: number; siteUrl?: string;
}
export interface MainConfig extends BotConfig { token: string; botHandle: string; stateDir: string; appDir: string; enabled: boolean; apiRoot?: string }
export interface ConfigMod { loadConfig(env: Record<string, string | undefined>): MainConfig }

export interface IdentityMod { sameBot(me: { username?: string }, handle: string): boolean }

export type InlineButton = { text: string; callback_data?: string; url?: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };
export interface TgSendOpts { html?: boolean; keyboard?: InlineKeyboard }
export interface TgClient {
  sendMessage(chatId: number, text: string, o?: TgSendOpts): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, o?: TgSendOpts): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action: "typing"): Promise<void>;
}
/** Форма GrammyError */
export interface TgApiError { error_code: number; description: string; parameters?: { retry_after?: number } }

export type LogRec = {
  ev: string; pseudo?: string; upd?: "message" | "callback" | "command" | "other"; ms?: number;
  status?: string; err?: string; version?: string;
};
export interface TelegramMod {
  withTelegramPolicy(raw: TgClient, d: { sleep(ms: number): Promise<void>; log(r: LogRec): void }): TgClient;
  /** grammyClient(api: import("grammy").Api) — харнес его не вызывает, тип ослаблен */
  grammyClient(api: unknown): TgClient;
}

/** Апдейт Telegram в урезанном виде §4.4. Харнес передаёт и сырые апдейты с лишними полями (TG.20) — через переменную */
export type TgUpdate = {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type: string } } };
};
export interface CoreDeps {
  config: BotConfig; tg: TgClient; fetch: typeof fetch; now?: () => number;
  random?: (n: number) => Uint8Array; sleep?: (ms: number) => Promise<void>; log?: (r: LogRec) => void;
}
export interface BotCore {
  /** Завершается после хода (или отказа) и никогда не отклоняется */
  handleUpdate(u: TgUpdate): Promise<void>;
  /** Все очереди пусты */
  idle(): Promise<void>;
  peek(chatId: number): { sessionId: string; messages: UIMessage[]; inputs?: ReportInputs } | undefined;
}
export interface CoreMod { createCore(d: CoreDeps): BotCore }

export interface Conv { pseudo: string; chatId: number; sessionId: string; messages: UIMessage[]; inputs?: ReportInputs; lastActive: number }
export interface RequestMod {
  userMessage(text: string, id: string): UIMessage;
  toWire(m: UIMessage): unknown;
  buildChatRequest(c: Conv, cfg: Pick<BotConfig, "webUrl" | "botKey">):
    { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } };
}

export type TurnOutcome = { ok: true; assistant: UIMessage }
  | { ok: false; reason: "refused" | "http" | "stream" | "timeout"; status?: number; partial?: UIMessage };
export interface TurnMod {
  runTurn(c: Conv, cfg: BotConfig, d: {
    fetch: typeof fetch; sleep(ms: number): Promise<void>;
    onToolInput?(toolCallId: string, toolName: string, partial: UIMessage): void;
  }): Promise<TurnOutcome>;
}

export type TgOp = { partIndex: number; toolCallId?: string; text: string; html: boolean; keyboard?: InlineKeyboard };
export interface RenderMod {
  renderTurn(m: UIMessage, o?: { siteUrl?: string; cabinetHref?: string }): TgOp[];
  renderReport(vm: ReportVM, o?: { siteUrl?: string; cabinetHref?: string; params?: EntryParams }): { html: string; keyboard?: InlineKeyboard };
  renderBranch(vm: BranchVM): { html: string; keyboard?: InlineKeyboard };
}

export interface HtmlMod {
  escapeHtml(s: string): string;
  htmlToPlain(h: string): string;
  visibleLength(h: string): number;
  splitHtml(h: string, max?: number): string[];
}

export interface IdsMod {
  pseudonymOf(chatId: number, salt: string): string;
  newSessionId(random: (n: number) => Uint8Array): string;
}

export interface ChatQueuesLike {
  run(key: string, job: () => Promise<void>): Promise<"done" | "busy">;
  idle(): Promise<void>;
  inFlight(): number;
}
export interface QueueMod { ChatQueues: new (o: { concurrency: number; perChatPending: number }) => ChatQueuesLike }

export interface LimitsMod {
  isAllowed(pseudo: string, allow: string): boolean;
  DailyLimit: new (perDay: number, now: () => number) => { take(pseudo: string): boolean };
}

export interface LogMod { makeLogger(sink: (line: string) => void, secrets: string[]): (r: LogRec) => void }

export interface HeartbeatMod {
  makeHeartbeat(o: { file: string; staleMs: number; now(): number; exit(code: number): void;
    write(file: string): void; mtime(file: string): number | null }): { beat(): void; check(): void };
}

export interface VersionMod {
  readVersion(appDir: string): string;
  checkServerVersion(f: typeof fetch, webUrl: string, mine: string): Promise<{ ok: boolean; server: string | null }>;
}

/* ═══════════════════════════ пути модулей и шаги, на которых они появятся ═══════════════════════════ */

interface ModSpec { rel: string; step: number; need: readonly string[] }

/** packages/present/src/<имя>.ts */
export const PRESENT = {
  protocol: { rel: "packages/present/src/protocol.ts", step: 2,
    need: ["TOOL_NAMES", "SESSION_TTL_MS", "BOT_TTL_MARGIN_MS", "HDR", "TG_SESSION_PREFIX", "CABINET_HREF"] },
  entry: { rel: "packages/present/src/entry.ts", step: 2,
    need: ["initialOf", "firstText", "chatParams", "pickMessage", "SUGGESTIONS", "encodeStartPayload", "decodeStartPayload"] },
  copy: { rel: "packages/present/src/copy.ts", step: 2,
    need: ["WAIT_REPORT", "WAIT_TERM", "DISCLAIMER", "limitText", "budgetExhaustedText", "BOT", "WEB"] },
  report: { rel: "packages/present/src/report.ts", step: 3,
    need: ["scoreTone", "liquidityTone", "presentReport", "presentBranch", "vmStrings"] },
} as const satisfies Record<string, ModSpec>;
export interface PresentMods { protocol: ProtocolMod; entry: EntryMod; copy: CopyMod; report: ReportMod }

/** apps/bot/src/<имя>.ts. main.ts здесь нет намеренно: его импорт запустил бы опрос Telegram */
export const BOT = {
  config: { rel: "apps/bot/src/config.ts", step: 5, need: ["loadConfig"] },
  identity: { rel: "apps/bot/src/identity.ts", step: 5, need: ["sameBot"] },
  telegram: { rel: "apps/bot/src/telegram.ts", step: 5, need: ["withTelegramPolicy", "grammyClient"] },
  core: { rel: "apps/bot/src/core.ts", step: 5, need: ["createCore"] },
  request: { rel: "apps/bot/src/request.ts", step: 5, need: ["userMessage", "toWire", "buildChatRequest"] },
  turn: { rel: "apps/bot/src/turn.ts", step: 5, need: ["runTurn"] },
  render: { rel: "apps/bot/src/render.ts", step: 5, need: ["renderTurn", "renderReport", "renderBranch"] },
  html: { rel: "apps/bot/src/html.ts", step: 5, need: ["escapeHtml", "htmlToPlain", "visibleLength", "splitHtml"] },
  ids: { rel: "apps/bot/src/ids.ts", step: 5, need: ["pseudonymOf", "newSessionId"] },
  queue: { rel: "apps/bot/src/queue.ts", step: 5, need: ["ChatQueues"] },
  limits: { rel: "apps/bot/src/limits.ts", step: 5, need: ["isAllowed", "DailyLimit"] },
  log: { rel: "apps/bot/src/log.ts", step: 5, need: ["makeLogger"] },
  heartbeat: { rel: "apps/bot/src/heartbeat.ts", step: 5, need: ["makeHeartbeat"] },
  version: { rel: "apps/bot/src/version.ts", step: 5, need: ["readVersion", "checkServerVersion"] },
} as const satisfies Record<string, ModSpec>;
export interface BotMods {
  config: ConfigMod; identity: IdentityMod; telegram: TelegramMod; core: CoreMod; request: RequestMod; turn: TurnMod;
  render: RenderMod; html: HtmlMod; ids: IdsMod; queue: QueueMod; limits: LimitsMod; log: LogMod; heartbeat: HeartbeatMod; version: VersionMod;
}

/** apps/web/lib/channel.ts */
export const CHANNEL = { rel: "apps/web/lib/channel.ts", step: 4, need: ["channelOf"] } as const satisfies ModSpec;

/** Абсолютный путь от корня репозитория */
export const repoAbs = (rel: string) => path.join(REPO_ROOT, rel);

/* ═══════════════════════════ загрузчик ═══════════════════════════ */

export type Loaded<T> = { ok: true; mod: T; rel: string } | { ok: false; detail: string; rel: string; missing: boolean };

const errText = (e: unknown) => {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.replace(/\s+/g, " ").trim().slice(0, 400);
};

/**
 * Динамический импорт модуля, которого может ещё не быть.
 * @param absPath абсолютный путь к .ts-файлу (импорт идёт по `pathToFileURL(absPath).href`, вычисляемым путём)
 * @param step    номер шага §5, на котором модуль появится («ожидаемо до шага N» в detail)
 * @param opts.need  имена экспортов, без которых модуль считается неготовым (`ok:false`, detail «нет экспорта …»)
 * @param opts.query строка запроса к URL (`?tg23=…`) — новый экземпляр модуля в том же процессе (TG.23)
 * @returns `{ok:true, mod}`; или `{ok:false, missing:true, detail:"нет модуля <rel>; ожидаемо до шага N"}`, если файла нет;
 *          или `{ok:false, missing:false, detail:"модуль <rel> есть, но не загрузился: …"}` / «…нет экспорта …». Никогда не бросает.
 */
export async function tryImport<T>(absPath: string, step: number | string, opts: { need?: readonly string[]; query?: string } = {}): Promise<Loaded<T>> {
  const rel = path.relative(REPO_ROOT, absPath) || absPath;
  if (!fs.existsSync(absPath)) return { ok: false, missing: true, rel, detail: `нет модуля ${rel}; ожидаемо до шага ${step}` };
  let mod: Record<string, unknown>;
  try {
    const url = pathToFileURL(absPath).href + (opts.query ? (opts.query.startsWith("?") ? opts.query : "?" + opts.query) : "");
    mod = (await import(url)) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, missing: false, rel, detail: `модуль ${rel} есть, но не загрузился (шаг ${step}): ${errText(e)}` };
  }
  const absent = (opts.need ?? []).filter((n) => !(n in mod) || mod[n] === undefined);
  if (absent.length) return { ok: false, missing: false, rel, detail: `в модуле ${rel} нет экспорта ${absent.join(", ")} (§4; шаг ${step})` };
  return { ok: true, mod: mod as T, rel };
}

/** `@so/present/<name>` из packages/present/src/<name>.ts; need по умолчанию — все экспорты §4.1 этого модуля */
export function loadPresent<K extends keyof PresentMods>(name: K, need?: readonly string[]): Promise<Loaded<PresentMods[K]>> {
  const s = PRESENT[name];
  return tryImport<PresentMods[K]>(repoAbs(s.rel), s.step, { need: need ?? s.need });
}
/** `apps/bot/src/<name>.ts`; need по умолчанию — все экспорты §4.4 этого модуля */
export function loadBot<K extends keyof BotMods>(name: K, need?: readonly string[]): Promise<Loaded<BotMods[K]>> {
  const s = BOT[name];
  return tryImport<BotMods[K]>(repoAbs(s.rel), s.step, { need: need ?? s.need });
}
/** `apps/web/lib/channel.ts` (шаг 4). Серверный модуль: если он импортирует "server-only", грузите его в сценарии (ребёнок ставит хук) */
export function loadChannel(): Promise<Loaded<ChannelMod>> {
  return tryImport<ChannelMod>(repoAbs(CHANNEL.rel), CHANNEL.step, { need: CHANNEL.need });
}

/**
 * Загрузить несколько модулей сразу. Первый неготовый даёт `ok:false` с его detail (остальные — в `details`).
 * Пример: `const m = await loadAll({ core: () => loadBot("core"), entry: () => loadPresent("entry") }); if (!m.ok) return fail(m.detail);`
 */
export async function loadAll<M extends Record<string, () => Promise<Loaded<unknown>>>>(
  loaders: M,
): Promise<{ ok: true; mods: { [K in keyof M]: Awaited<ReturnType<M[K]>> extends Loaded<infer T> ? T : never } } | { ok: false; detail: string; details: string[] }> {
  const out: Record<string, unknown> = {};
  const details: string[] = [];
  for (const [k, load] of Object.entries(loaders)) {
    const r = await load();
    if (r.ok) out[k] = r.mod; else details.push(r.detail);
  }
  if (details.length) return { ok: false, detail: details.join("; "), details };
  return { ok: true, mods: out as { [K in keyof M]: Awaited<ReturnType<M[K]>> extends Loaded<infer T> ? T : never } };
}
