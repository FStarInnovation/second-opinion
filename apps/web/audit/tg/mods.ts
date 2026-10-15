/**
 * WP-TG: модули, которых до правки нет (packages/present/src/*, apps/bot/src/*, apps/web/lib/channel.ts), грузятся динамическим
 * import по вычисляемому пути. Нет файла → { ok:false, why:"нет модуля …; ожидаемо до шага N" } — проверка RED, а не ERROR.
 * Сигнатуры — §4 docs/PLAN_telegram_bot_2026-10-14.md, продублированы здесь структурными типами: typecheck @so/web не зависит
 * от того, написаны ли модули. Если сигнатура в плане меняется — правится §4 плана и этот файл (решение оркестратора).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BondReportT, BuildResultT, ReportInputs } from "@so/engine/contract";
import { REPO_ROOT } from "../lib";

export type Loaded<T> = { ok: true; mod: T; file: string } | { ok: false; why: string; file: string };
const rel = (f: string) => path.relative(REPO_ROOT, f);
const errMsg = (e: unknown) => String(e instanceof Error ? `${e.name}: ${e.message}` : e).replace(/\s+/g, " ").slice(0, 240);

export const PRESENT_FILE = (name: "protocol" | "entry" | "copy" | "report") => path.join(REPO_ROOT, "packages", "present", "src", `${name}.ts`);
export const BOT_DIR = path.join(REPO_ROOT, "apps", "bot");
export const BOT_FILE = (name: string) => path.join(BOT_DIR, "src", `${name}.ts`);
export const CHANNEL_FILE = path.join(REPO_ROOT, "apps", "web", "lib", "channel.ts");

/** Шаг плана (§5), на котором модуль должен появиться */
export const STEP = { present: "2 (P1)", report: "3 (P2)", server: "4 (P3)", bot: "5 (P4)", ops: "6 (P5)" } as const;

export async function load<T>(file: string, label: string, step: string, need: string[] = []): Promise<Loaded<T>> {
  if (!fs.existsSync(file)) return { ok: false, file, why: `нет модуля ${label} (${rel(file)} не найден); ожидаемо до шага ${step}` };
  let mod: Record<string, unknown>;
  try { mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>; }
  catch (e) { return { ok: false, file, why: `модуль ${label} (${rel(file)}) не загружается: ${errMsg(e)}` }; }
  const missing = need.filter((k) => !(k in mod));
  if (missing.length) return { ok: false, file, why: `в модуле ${label} нет экспорта ${missing.join(", ")} (§4 плана)` };
  return { ok: true, mod: mod as T, file };
}

/* ───────────── @so/present ───────────── */
export type Channel = "web" | "telegram";
export interface ProtocolMod {
  TOOL_NAMES: readonly string[]; SESSION_TTL_MS: number; BOT_TTL_MARGIN_MS: number;
  HDR: { chat: string; channel: string; botKey: string }; TG_SESSION_PREFIX: string;
}
export type EntryParams = { q?: string; promised?: string; pos?: string; k?: string; price?: string; m?: string };
export type ChatInitial = { q: string; inputs: ReportInputs; text?: undefined } | { text: string; q?: undefined; inputs?: undefined };
export interface EntryMod {
  initialOf(p: EntryParams): ChatInitial | undefined;
  firstText(i: ChatInitial): string;
  chatParams(res: BuildResultT, query: string): EntryParams | null;
  pickMessage(c: { isin?: string | null; secid: string }): string;
  SUGGESTIONS: readonly string[];
  encodeStartPayload(p: EntryParams): string | null;
  decodeStartPayload(s: string): EntryParams | null;
}
export interface BotCopy {
  start: string; help: string; privacy: string; newSession: string; sessionExpired: string; busy: string; onlyText: string;
  serviceRestarting: string; turnFailed: string; dailyLimit(n: number): string; notAllowed(code: string): string; fullReport: string; openOnSite: string;
}
export interface CopyMod {
  WAIT_REPORT: string; WAIT_TERM: string; DISCLAIMER: string;
  limitText(ch: Channel, limit: number): string; budgetExhaustedText(ch: Channel): string;
  BOT: BotCopy; WEB: Record<string, string>;
}
/** VM — минимальный состав §4.1; P2 добавляет поля (подписи колонок pick, кнопка и примечание плашки…), чтобы VM покрыла весь
 *  видимый текст блоков чата (обратная проверка TG.6). Харнес читает VM только через vmStrings — от состава полей не зависит. */
export interface SectionVM { id: string; title: string; subtitle?: string; big?: string; tone?: string; lines: string[]; bars?: { label: string; value: string }[]; items?: { title: string; text: string }[] }
export interface ReportVM { dataTime: string | null; kicker: string; name: string; isin: string | null; sections: SectionVM[]; plaque: { title: string; items: string[] } | null }
export type BranchVM =
  | { kind: "pick"; title: string; lines: string[]; options: { label: string; message: string; traded: boolean }[] }
  | { kind: "notfound" | "err"; title: string; lines: string[] };
export interface ReportMod {
  /** Опций нет: подсказка «нет цены» (askPriceUnavailableNote) — реакция веб-контрола, в SSR не видна и в VM не входит (§4.1) */
  presentReport(r: BondReportT): ReportVM;
  presentBranch(res: BuildResultT): BranchVM;
  vmStrings(vm: ReportVM | BranchVM): string[];
}
export const loadProtocol = () => load<ProtocolMod>(PRESENT_FILE("protocol"), "@so/present/protocol", STEP.present, ["SESSION_TTL_MS", "BOT_TTL_MARGIN_MS", "HDR", "TG_SESSION_PREFIX", "TOOL_NAMES"]);
export const loadEntry = () => load<EntryMod>(PRESENT_FILE("entry"), "@so/present/entry", STEP.present, ["initialOf", "firstText", "chatParams", "pickMessage", "SUGGESTIONS", "encodeStartPayload", "decodeStartPayload"]);
export const loadCopy = () => load<CopyMod>(PRESENT_FILE("copy"), "@so/present/copy", STEP.present, ["WAIT_REPORT", "WAIT_TERM", "DISCLAIMER", "limitText", "budgetExhaustedText", "BOT", "WEB"]);
export const loadReport = () => load<ReportMod>(PRESENT_FILE("report"), "@so/present/report", STEP.report, ["presentReport", "presentBranch", "vmStrings"]);

/* ───────────── сервер ───────────── */
export interface ChannelMod { channelOf(req: Request, sessionId: string): { ok: true; channel: Channel } | { ok: false; status: 403 } }
export const loadChannel = () => load<ChannelMod>(CHANNEL_FILE, "apps/web/lib/channel.ts", STEP.server, ["channelOf"]);

/* ───────────── apps/bot/src ───────────── */
export type UIMsg = { id: string; role: string; parts: Array<Record<string, unknown>>; metadata?: unknown };
export type InlineKeyboard = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
export interface TgSendOpts { html?: boolean; keyboard?: InlineKeyboard }
export interface TgClient {
  sendMessage(chatId: number, text: string, o?: TgSendOpts): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, o?: TgSendOpts): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action: "typing"): Promise<void>;
}
export interface TgApiError { error_code: number; description: string; parameters?: { retry_after?: number } }
export type LogRec = { ev: string; pseudo?: string; upd?: string; ms?: number; status?: string; err?: string; version?: string };
export interface BotConfig {
  webUrl: string; botKey: string; salt: string; allow: string; dailyTurns: number; concurrency: number;
  perChatPending: number; maxChats: number; turnTimeoutMs: number; siteUrl?: string;
}
export type TgUpdate = {
  update_id: number;
  message?: Record<string, unknown> & { message_id: number; chat: { id: number; type: string }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type: string } } };
};
export interface CoreDeps {
  config: BotConfig; tg: TgClient; fetch: typeof fetch; now?: () => number; random?: (n: number) => Uint8Array;
  sleep?: (ms: number) => Promise<void>; log?: (r: LogRec) => void;
}
export interface BotCore {
  handleUpdate(u: TgUpdate): Promise<void>;
  idle(): Promise<void>;
  peek(chatId: number): { sessionId: string; messages: UIMsg[]; inputs?: ReportInputs } | undefined;
}
export interface CoreMod { createCore(d: CoreDeps): BotCore }
export interface TgOp { partIndex: number; toolCallId?: string; text: string; html: boolean; keyboard?: InlineKeyboard }
export interface RenderMod {
  renderTurn(m: UIMsg, o?: { siteUrl?: string; cabinetHref?: string }): TgOp[];
  renderReport(vm: ReportVM, o?: { siteUrl?: string; cabinetHref?: string; params?: EntryParams }): { html: string; keyboard?: InlineKeyboard };
  renderBranch(vm: BranchVM): { html: string; keyboard?: InlineKeyboard };
}
export interface HtmlMod { escapeHtml(s: string): string; htmlToPlain(h: string): string; visibleLength(h: string): number; splitHtml(h: string, max?: number): string[] }
export interface IdsMod { pseudonymOf(chatId: number, salt: string): string; newSessionId(pseudo: string, random: (n: number) => Uint8Array): string }
export interface LimitsMod {
  isAllowed(pseudo: string, allow: string): boolean;
  DailyLimit: new (perDay: number, now: () => number) => { take(pseudo: string): boolean };
}
export interface LogMod { makeLogger(sink: (line: string) => void, secrets: string[]): (r: LogRec) => void }
export interface HeartbeatMod {
  makeHeartbeat(o: { file: string; staleMs: number; now(): number; exit(code: number): void; write(file: string): void; mtime(file: string): number | null }): { beat(): void; check(): void };
}
/** readVersion — <appDir>/VERSION (sha кода на диске) или "dev"; checkServerVersion — version локального /api/health (sha сборки, SO_BUILD_SHA) против своей */
export interface VersionMod { readVersion(appDir: string): string; checkServerVersion(f: typeof fetch, webUrl: string, mine: string): Promise<{ ok: boolean; server: string | null }> }
export interface TelegramMod { withTelegramPolicy(raw: TgClient, d: { sleep(ms: number): Promise<void>; log(r: LogRec): void }): TgClient }

const bot = <T>(name: string, need: string[]) => () => load<T>(BOT_FILE(name), `apps/bot/src/${name}.ts`, STEP.bot, need);
export const loadCore = bot<CoreMod>("core", ["createCore"]);
export const loadRender = bot<RenderMod>("render", ["renderTurn", "renderReport", "renderBranch"]);
export const loadHtml = bot<HtmlMod>("html", ["escapeHtml", "htmlToPlain", "visibleLength", "splitHtml"]);
export const loadIds = bot<IdsMod>("ids", ["pseudonymOf", "newSessionId"]);
export const loadLimits = bot<LimitsMod>("limits", ["isAllowed", "DailyLimit"]);
export const loadLog = bot<LogMod>("log", ["makeLogger"]);
export const loadHeartbeat = bot<HeartbeatMod>("heartbeat", ["makeHeartbeat"]);
export const loadVersion = bot<VersionMod>("version", ["readVersion", "checkServerVersion"]);
export const loadTelegram = bot<TelegramMod>("telegram", ["withTelegramPolicy"]);

/** Несколько модулей сразу: первый отсутствующий — причина RED */
export async function loadAll<T extends Record<string, Promise<Loaded<unknown>>>>(m: T): Promise<
  { ok: true; mods: { [K in keyof T]: T[K] extends Promise<Loaded<infer U>> ? U : never } } | { ok: false; why: string }
> {
  const out: Record<string, unknown> = {};
  const why: string[] = [];
  for (const [k, p] of Object.entries(m)) {
    const r = await p;
    if (r.ok) out[k] = r.mod; else why.push(r.why);
  }
  if (why.length) return { ok: false, why: why.join("; ") };
  return { ok: true, mods: out as { [K in keyof T]: T[K] extends Promise<Loaded<infer U>> ? U : never } };
}
