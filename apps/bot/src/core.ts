/**
 * Ядро Telegram-бота (план WP-TG §4.4, §4.7, §8, §9). Решений о диалоге здесь нет (И1): ядро превращает апдейт Telegram в реплику,
 * шлёт в POST /api/chat то же тело, что браузер (request.ts), собирает ответ функциями ai (turn.ts) и раскладывает его в сообщения
 * (render.ts). Окружение и сеть — только внедрённые: config, fetch, TgClient, часы, random, sleep, log.
 *
 * Что делает ядро:
 *  - /start — новый разговор, приветствие с уведомлением о приватности и кнопками подсказок sg:<i>;
 *  - /start <payload> — уведомление о приватности, новый разговор с вводами ссылки (inputs в каждом запросе) и ход firstText;
 *  - /new — новый разговор; /help (и неизвестная команда) — справка;
 *  - кнопки: pk:<ISIN|SECID> → реплика pickMessage, sg:<i> → SUGGESTIONS[i]; во время хода — answerCallbackQuery(BOT.busy);
 *  - не private-чат — игнор; не текст — BOT.onlyText; не в allowlist — BOT.notAllowed(код доступа); дневной лимит — BOT.dailyLimit.
 * Очередь: ходы чата по одному, ждут не больше perChatPending, лишнее — BOT.busy; всего ходов в работе — не больше concurrency.
 * Повтор update_id — игнор.
 *
 * Ход: реплика пишется в историю; POST; на tool-input-available — сначала каждая ещё не отправленная text-часть перед
 * инструментом (независимо от state), затем заглушка WAIT_REPORT; ответ ассистента (сырой UIMessage) пишется в историю ДО
 * доставки; затем операции renderTurn: уже отправленный текст пропускается (изменился — правится), отчёт правит заглушку.
 * Пока ход идёт — typing каждые 4 с, без повторов: после 429 в этом ходе и после конца хода typing не шлётся.
 *
 * Ошибки доставки: каждая операция TgClient — в try/catch, в журнал {ev:"tg_error", status}; 403 — остальные операции хода не
 * отправляются; 400 «message to edit not found» / «message can't be edited» — то же сообщение новым sendMessage; сеть или 429
 * сверх повторов — операция пропускается, следующие идут. Историю ошибка доставки не откатывает.
 * Исходы хода: refused (ECONNREFUSED после повторов) — реплика убирается из истории, BOT.serviceRestarting; http, stream,
 * timeout — реплика и частичный ответ остаются (как у AbstractChat), BOT.turnFailed.
 *
 * Приватность (§8): chat_id и псевдоним живут только в записях разговоров в памяти; разговор закрывается после
 * SESSION_TTL_MS − BOT_TTL_MARGIN_MS простоя (sweep) или вытесняется LRU сверх maxChats — тогда в памяти остаётся только
 * псевдоним (для уведомления «прошлый разговор закрыт»). В журнал не пишутся тексты, id и имена; pseudo — только в отказах.
 */
import { randomBytes } from "node:crypto";
import { generateId, type UIMessage } from "ai";
import type { ReportInputs } from "@so/engine/contract";
import { BOT, WAIT_REPORT } from "@so/present/copy";
import { decodeStartPayload, firstText, initialOf, pickMessage, SUGGESTIONS } from "@so/present/entry";
import { BOT_TTL_MARGIN_MS, CABINET_HREF, SESSION_TTL_MS } from "@so/present/protocol";
import type { BotConfig } from "./config";
import { newSessionId, pseudonymOf } from "./ids";
import { DailyLimit, isAllowed } from "./limits";
import type { LogRec } from "./log";
import { ChatQueues } from "./queue";
import { CB_PICK, CB_SUGGEST, plainChunks, REPORT_TOOLS, renderTurn, type TgOp } from "./render";
import { userMessage, type Conv } from "./request";
import { tgErrorInfo, type InlineKeyboard, type TgClient, type TgSendOpts } from "./telegram";
import { runTurn } from "./turn";

export type TgUpdate = { update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type: string } } } };

export interface CoreDeps { config: BotConfig; tg: TgClient; fetch: typeof fetch; now?: () => number;
  random?: (n: number) => Uint8Array; sleep?: (ms: number) => Promise<void>; log?: (r: LogRec) => void }

export interface BotCore {
  /** Завершается после хода (или отказа) и никогда не отклоняется */
  handleUpdate(u: TgUpdate): Promise<void>;
  /** Все очереди пусты */
  idle(): Promise<void>;
  /** Состояние разговора чата — для харнеса */
  peek(chatId: number): { sessionId: string; messages: UIMessage[]; inputs?: ReportInputs } | undefined;
}

/** Сколько живёт история бота без активности: меньше серверной сессии на запас */
const CONV_LIFE_MS = SESSION_TTL_MS - BOT_TTL_MARGIN_MS;
/** typing — каждые 4 с, пока ход идёт */
const TYPING_EVERY_MS = 4000;
/** Сколько последних update_id помнить (повтор апдейта — игнор) */
const SEEN_MAX = 5000;
/** Сколько псевдонимов закрытых разговоров помнить для уведомления «прошлый разговор закрыт» */
const CLOSED_MAX = 2000;

type Upd = NonNullable<LogRec["upd"]>;
/** Состояние доставки одного хода */
interface Delivery { chatId: number; blocked: boolean }
/** Задание хода в очереди чата */
interface TurnJob { text: string; upd: Upd; fresh?: { inputs?: ReportInputs }; notice?: string }

/** Команда бота: /name[@bot] [аргумент] */
function parseCommand(text: string): { name: string; arg: string } | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), arg: (m[2] ?? "").trim() } : null;
}

const errName = (e: unknown) => (e instanceof Error ? e.name : typeof e);

/** Ядро бота */
export function createCore(d: CoreDeps): BotCore & { sweep(): void } {
  const cfg = d.config;
  const tg = d.tg;
  const now = d.now ?? (() => Date.now());
  const random = d.random ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  const log = (r: LogRec) => { try { d.log?.(r); } catch { /* журнал не роняет ход */ } };
  const renderOpts = { ...(cfg.siteUrl ? { siteUrl: cfg.siteUrl } : {}), cabinetHref: CABINET_HREF };

  const queues = new ChatQueues({ concurrency: cfg.concurrency, perChatPending: cfg.perChatPending });
  const daily = new DailyLimit(cfg.dailyTurns, now);
  /** разговоры по chat_id; порядок вставки = давность использования (LRU) */
  const convs = new Map<number, Conv>();
  /** псевдонимы закрытых по простою или вытесненных разговоров */
  const closed = new Set<string>();
  const seen = new Set<number>();
  /** сколько ходов чата в очереди и в работе (кнопка во время хода → busy) */
  const load = new Map<number, number>();
  const inflight = new Set<Promise<void>>();

  /* ───── Telegram: каждая операция в try/catch ───── */

  function tgFail(e: unknown, dl?: Delivery): void {
    const i = tgErrorInfo(e);
    log({ ev: "tg_error", status: String(i.code ?? "net"), ...(i.short ? { err: i.short } : {}) });
    if (i.code === 403 && dl) dl.blocked = true;
  }
  async function send(chatId: number, text: string, o?: TgSendOpts, dl?: Delivery): Promise<number | null> {
    if (dl?.blocked) return null;
    try {
      const r = await tg.sendMessage(chatId, text, o);
      return typeof r?.message_id === "number" ? r.message_id : null;
    } catch (e) {
      tgFail(e, dl);
      return null;
    }
  }
  /** Правка сообщения; не найдено или не правится — то же новым сообщением */
  async function edit(chatId: number, messageId: number, text: string, o: TgSendOpts | undefined, dl: Delivery): Promise<void> {
    if (dl.blocked) return;
    try {
      await tg.editMessageText(chatId, messageId, text, o);
    } catch (e) {
      tgFail(e, dl);
      const i = tgErrorInfo(e);
      if (i.code === 400 && /message to edit not found|message can't be edited/i.test(i.description)) await send(chatId, text, o, dl);
    }
  }
  async function answer(id: string, text?: string): Promise<void> {
    try { await tg.answerCallbackQuery(id, text); } catch (e) { tgFail(e); }
  }

  /* ───── разговоры ───── */

  const remember = <T>(set: Set<T>, v: T, max: number) => {
    set.delete(v);
    set.add(v);
    while (set.size > max) { const first = set.values().next().value as T; set.delete(first); }
  };
  /** Закрыть разговор: в памяти остаётся только псевдоним (для уведомления) */
  function close(chatId: number): void {
    const c = convs.get(chatId);
    if (!c) return;
    convs.delete(chatId);
    remember(closed, c.pseudo, CLOSED_MAX);
  }
  /** Новый разговор чата (прежний, если был, забывается); сверх maxChats вытесняется самый давний */
  function fresh(chatId: number, pseudo: string, inputs?: ReportInputs): Conv {
    const c: Conv = { pseudo, chatId, sessionId: newSessionId(random), messages: [], lastActive: now(), ...(inputs !== undefined ? { inputs } : {}) };
    convs.delete(chatId);
    closed.delete(pseudo);
    convs.set(chatId, c);
    // LRU: вытесняется самый давний разговор без хода в работе (у занятого чата история нужна его ходу)
    for (const id of [...convs.keys()]) {
      if (convs.size <= Math.max(1, cfg.maxChats)) break;
      if (id !== chatId && !load.has(id)) close(id);
    }
    return c;
  }
  /** Текущий разговор чата; истёк или был закрыт — новый и уведомление BOT.sessionExpired */
  async function current(chatId: number, pseudo: string, dl: Delivery): Promise<Conv> {
    const c = convs.get(chatId);
    if (c && now() - c.lastActive <= CONV_LIFE_MS) {
      convs.delete(chatId);
      convs.set(chatId, c); // LRU: свежий — в конец
      return c;
    }
    const expired = !!c || closed.has(pseudo);
    const n = fresh(chatId, pseudo);
    if (expired) {
      log({ ev: "session_expired" });
      await send(chatId, BOT.sessionExpired, undefined, dl);
    }
    return n;
  }
  /** Закрыть разговоры, простоявшие дольше CONV_LIFE_MS (сырые chat_id не живут в памяти дольше срока, §8) */
  function sweep(): void {
    const t = now();
    for (const [chatId, c] of [...convs]) if (t - c.lastActive > CONV_LIFE_MS && !load.has(chatId)) close(chatId);
  }

  /* ───── ход ───── */

  async function runJob(chatId: number, pseudo: string, j: TurnJob): Promise<void> {
    const t0 = now();
    const dl: Delivery = { chatId, blocked: false };
    if (j.notice) await send(chatId, j.notice, undefined, dl);
    if (!daily.take(pseudo)) {
      log({ ev: "dailyLimit", pseudo, upd: j.upd });
      await send(chatId, BOT.dailyLimit(cfg.dailyTurns), undefined, dl);
      return;
    }
    const conv = j.fresh ? fresh(chatId, pseudo, j.fresh.inputs) : await current(chatId, pseudo, dl);
    const um = userMessage(j.text, generateId());
    conv.messages.push(um);
    conv.lastActive = now();

    // typing, пока ход идёт: «как получится» — после конца хода и после первого 429 в ходе больше не шлётся
    let typingOn = true;
    const typing = () => {
      if (!typingOn || dl.blocked) return;
      Promise.resolve().then(() => (typingOn ? tg.sendChatAction(chatId, "typing") : undefined)).catch((e: unknown) => {
        if (tgErrorInfo(e).code === 429) typingOn = false;
        tgFail(e, dl);
      });
    };
    typing();
    const typingTimer = setInterval(typing, TYPING_EVERY_MS);
    const stopTyping = () => { typingOn = false; clearInterval(typingTimer); };

    // то, что ушло в Telegram во время хода: text-части (по partIndex) и заглушки инструментов (по toolCallId)
    const sentText = new Map<number, { texts: string[]; ids: (number | null)[] }>();
    const placeholders = new Map<string, { id: number | null; used: boolean }>();
    let chain: Promise<void> = Promise.resolve();
    const later = (fn: () => Promise<void>) => { chain = chain.then(fn).catch(() => { /* ошибки уже в журнале */ }); };

    const onToolInput = (toolCallId: string, toolName: string, partial: UIMessage) => {
      const parts = partial.parts as { type: string; text?: string; toolCallId?: string }[];
      const at = parts.findIndex((p) => p.toolCallId === toolCallId);
      for (let i = 0; i < (at < 0 ? parts.length : at); i++) {
        const p = parts[i];
        if (p.type !== "text" || sentText.has(i)) continue;
        const texts = plainChunks(p.text ?? "");
        if (!texts.length) continue;
        const rec = { texts, ids: [] as (number | null)[] };
        sentText.set(i, rec);
        later(async () => { for (const t of texts) rec.ids.push(await send(chatId, t, undefined, dl)); });
      }
      if (REPORT_TOOLS.has(toolName) && !placeholders.has(toolCallId)) {
        const ph = { id: null as number | null, used: false };
        placeholders.set(toolCallId, ph);
        later(async () => { ph.id = await send(chatId, WAIT_REPORT, undefined, dl); });
      }
    };

    /** Операции renderTurn с учётом уже отправленного: текст — пропуск или правка; первая часть инструмента — правка заглушки */
    const deliver = async (ops: TgOp[]) => {
      const textSeen = new Map<number, number>();
      for (const op of ops) {
        if (dl.blocked) return;
        const o: TgSendOpts | undefined = op.html || op.keyboard
          ? { ...(op.html ? { html: true } : {}), ...(op.keyboard ? { keyboard: op.keyboard as InlineKeyboard } : {}) } : undefined;
        const pre = op.toolCallId == null ? sentText.get(op.partIndex) : undefined;
        if (pre) {
          const k = textSeen.get(op.partIndex) ?? 0;
          textSeen.set(op.partIndex, k + 1);
          const id = k < pre.ids.length ? pre.ids[k] : null;
          if (id != null) {
            if (pre.texts[k] !== op.text) await edit(chatId, id, op.text, o, dl);
            continue;
          }
          await send(chatId, op.text, o, dl);
          continue;
        }
        if (op.toolCallId != null) {
          const ph = placeholders.get(op.toolCallId);
          if (ph && !ph.used) {
            ph.used = true;
            if (ph.id != null) { await edit(chatId, ph.id, op.text, o, dl); continue; }
          }
        }
        await send(chatId, op.text, o, dl);
      }
    };

    let status = "ok";
    try {
      const out = await runTurn(conv, cfg, { fetch: d.fetch, sleep, onToolInput });
      stopTyping();
      await chain;
      if (out.ok) {
        conv.messages.push(out.assistant); // в историю — до доставки: сервер уже засчитал ход
        conv.lastActive = now();
        await deliver(renderTurn(out.assistant, renderOpts));
      } else if (out.reason === "refused") {
        status = "refused";
        const k = conv.messages.lastIndexOf(um);
        if (k >= 0) conv.messages.splice(k, 1); // ход не начат — реплики в истории нет
        await send(chatId, BOT.serviceRestarting, undefined, dl);
      } else {
        status = out.status != null ? `${out.reason}:${out.status}` : out.reason;
        if (out.partial) {
          conv.messages.push(out.partial); // как AbstractChat: частичный ответ остаётся
          conv.lastActive = now();
          await deliver(renderTurn(out.partial, renderOpts));
        }
        await send(chatId, BOT.turnFailed, undefined, dl);
      }
    } finally {
      stopTyping();
      log({ ev: "turn", upd: j.upd, ms: Math.max(0, now() - t0), status: dl.blocked ? `${status}:blocked` : status });
    }
  }

  /** Поставить ход в очередь чата; очередь полна — BOT.busy */
  async function enqueue(chatId: number, pseudo: string, j: TurnJob): Promise<void> {
    load.set(chatId, (load.get(chatId) ?? 0) + 1);
    try {
      const r = await queues.run(String(chatId), () => runJob(chatId, pseudo, j));
      if (r === "busy") {
        log({ ev: "busy", upd: j.upd });
        await send(chatId, BOT.busy);
      }
    } finally {
      const n = (load.get(chatId) ?? 1) - 1;
      if (n > 0) load.set(chatId, n); else load.delete(chatId);
    }
  }

  /* ───── апдейты ───── */

  const suggestions = (): InlineKeyboard => ({ inline_keyboard: SUGGESTIONS.map((s, i) => [{ text: s, callback_data: `${CB_SUGGEST}${i}` }]) });

  async function onMessage(m: NonNullable<TgUpdate["message"]>): Promise<void> {
    const chat = m.chat;
    if (!chat || chat.type !== "private" || typeof chat.id !== "number") return;
    const chatId = chat.id;
    const pseudo = pseudonymOf(chatId, cfg.salt);
    const text = typeof m.text === "string" ? m.text : null;
    const cmd = text != null ? parseCommand(text) : null;
    const upd: Upd = cmd ? "command" : text != null ? "message" : "other";
    if (!isAllowed(pseudo, cfg.allow)) {
      log({ ev: "notAllowed", pseudo, upd });
      await send(chatId, BOT.notAllowed(pseudo));
      return;
    }
    if (text == null) { await send(chatId, BOT.onlyText); return; }
    if (cmd) {
      if (cmd.name === "start") {
        const p = cmd.arg ? decodeStartPayload(cmd.arg) : null;
        const i = p ? initialOf(p) : undefined;
        if (i && i.q !== undefined) return enqueue(chatId, pseudo, { text: firstText(i), upd, fresh: { inputs: i.inputs }, notice: BOT.privacy });
        fresh(chatId, pseudo);
        await send(chatId, `${BOT.start}\n\n${BOT.privacy}`, { keyboard: suggestions() });
        return;
      }
      if (cmd.name === "new") { fresh(chatId, pseudo); await send(chatId, BOT.newSession); return; }
      await send(chatId, BOT.help); // /help и неизвестная команда
      return;
    }
    if (!text.trim()) return;
    return enqueue(chatId, pseudo, { text, upd });
  }

  /** Реплика по callback_data; не наша кнопка — null */
  function callbackText(data: string | undefined): string | null {
    if (typeof data !== "string") return null;
    if (data.startsWith(CB_PICK)) {
      const code = data.slice(CB_PICK.length);
      return /^[A-Za-z0-9]{1,40}$/.test(code) ? pickMessage({ secid: code }) : null;
    }
    if (data.startsWith(CB_SUGGEST)) {
      const i = Number(data.slice(CB_SUGGEST.length));
      return Number.isInteger(i) && i >= 0 && i < SUGGESTIONS.length ? SUGGESTIONS[i] : null;
    }
    return null;
  }

  async function onCallback(q: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
    const chat = q.message?.chat;
    if (!chat || chat.type !== "private" || typeof chat.id !== "number") return;
    const chatId = chat.id;
    const pseudo = pseudonymOf(chatId, cfg.salt);
    if (!isAllowed(pseudo, cfg.allow)) {
      log({ ev: "notAllowed", pseudo, upd: "callback" });
      await answer(q.id);
      await send(chatId, BOT.notAllowed(pseudo));
      return;
    }
    const text = callbackText(q.data);
    if (text == null) { await answer(q.id); return; }
    if ((load.get(chatId) ?? 0) > 0) {
      log({ ev: "busy", upd: "callback" });
      await answer(q.id, BOT.busy);
      return;
    }
    // ход занимает чат ДО первого await: второе нажатие из той же пачки getUpdates (или пока идёт answerCallbackQuery) — busy
    const turn = enqueue(chatId, pseudo, { text, upd: "callback" });
    await answer(q.id);
    return turn;
  }

  async function handle(u: TgUpdate): Promise<void> {
    if (!u || typeof u.update_id !== "number") return;
    if (seen.has(u.update_id)) return;
    remember(seen, u.update_id, SEEN_MAX);
    sweep();
    if (u.message) return onMessage(u.message);
    if (u.callback_query) return onCallback(u.callback_query);
  }

  return {
    handleUpdate(u: TgUpdate): Promise<void> {
      let p: Promise<void>;
      try {
        p = handle(u).catch((e: unknown) => { log({ ev: "core_error", err: errName(e) }); });
      } catch (e) {
        log({ ev: "core_error", err: errName(e) });
        p = Promise.resolve();
      }
      inflight.add(p);
      void p.then(() => { inflight.delete(p); });
      return p;
    },
    async idle(): Promise<void> {
      for (;;) {
        if (inflight.size) { await Promise.allSettled([...inflight]); continue; }
        await queues.idle();
        if (!inflight.size) return;
      }
    },
    peek(chatId: number) {
      const c = convs.get(chatId);
      if (!c) return undefined;
      return { sessionId: c.sessionId, messages: c.messages, ...(c.inputs !== undefined ? { inputs: c.inputs } : {}) };
    },
    sweep,
  };
}
