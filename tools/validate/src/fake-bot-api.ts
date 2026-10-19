/**
 * Фейковый Telegram Bot API для e2e бота (план WP-TG §5 шаг 6, P5): HTTP-сервер на 127.0.0.1, порт — свободный (0).
 * Бот (grammY, apps/bot/src/main.ts) ходит сюда вместо api.telegram.org через TG_API_ROOT=http://127.0.0.1:<порт>
 * (только e2e: loadConfig принимает лишь loopback с явным портом и падает при NODE_ENV=production).
 *
 * Путь запроса — как у grammY: POST /bot<токен>/<метод>, тело JSON. Чужой токен → 401, как у Telegram.
 *  - getMe → бот с username = TG_BOT_USERNAME (сверка sameBot в main.ts);
 *  - deleteWebhook → true (bot.start() вызывает его перед опросом);
 *  - getUpdates → очередь апдейтов с update_id ≥ offset (меньшие подтверждены и выбрасываются); пустая очередь и timeout > 0 —
 *    запрос держится до нового апдейта или до timeout, обрыв запроса (AbortController grammY при bot.stop()) — снимается;
 *  - sendMessage, editMessageText, answerCallbackQuery, sendChatAction — записываются; sendMessage выдаёт возрастающие message_id.
 * Ограничения Telegram проверяются, как у настоящего API (400 с тем же описанием), чтобы e2e ловил то, на чём упал бы прод:
 * пустой текст и длина > 4096 после разбора сущностей («message is too long»); parse_mode HTML — только теги Bot API,
 * сбалансированные, сущности &lt; &gt; &amp; &quot; и числовые («can't parse entities»); callback_data 1–64 байт, у кнопки ровно
 * одно из url / callback_data; правка чужого или несуществующего сообщения — «message to edit not found», тот же текст —
 * «message is not modified».
 * Апдейты задаёт e2e (push): форма — сырой апдейт Telegram, update_id выдаёт фейк.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

/** Запись вызова Bot API */
export interface ApiCall {
  /** порядковый номер вызова (общий для всех методов) */
  seq: number;
  method: string;
  params: Record<string, unknown>;
  /** ответ фейка: ok — result отдан, иначе error_code и description */
  ok: boolean;
  error?: { error_code: number; description: string };
  /** message_id, выданный sendMessage */
  messageId?: number;
  /** getUpdates: update_id, отданные в ответе (до ответа — undefined) */
  updates?: number[];
  at: number;
}

export interface FakeBotApi {
  /** http://127.0.0.1:<порт> — значение TG_API_ROOT */
  root: string;
  calls: ApiCall[];
  /** Поставить апдейт в очередь getUpdates; update_id выдаёт фейк. @returns update_id */
  push(update: Record<string, unknown>): number;
  /** update_id, отданные боту в getUpdates (доставлены) */
  delivered: Set<number>;
  /** последний offset, которым бот подтвердил апдейты (getUpdates с offset) */
  lastOffset(): number;
  /** Ждать вызова, для которого pred истинен (среди всех вызовов с seq > after); таймаут → null */
  waitFor(pred: (c: ApiCall) => boolean, timeoutMs: number, after?: number): Promise<ApiCall | null>;
  /** Ждать, пока апдейт будет отдан боту */
  waitDelivered(updateId: number, timeoutMs: number): Promise<boolean>;
  /** Запросы с чужим токеном или к неизвестному методу (должно быть пусто) */
  rejected: { path: string; why: string }[];
  /** Задержка ответа (мс) на вызов — «медленный Telegram»: держит ход бота в полёте (сценарий SIGTERM); null — без задержки */
  delay: ((method: string, params: Record<string, unknown>) => number) | null;
  close(): Promise<void>;
}

/** Теги HTML, которые принимает Bot API (parse_mode HTML) */
const TG_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "span", "tg-spoiler", "tg-emoji", "blockquote"]);
const TG_MAX_LEN = 4096;
const CB_MAX_BYTES = 64;

/** Видимый текст HTML Bot API: теги сняты, сущности раскодированы. Ошибка разбора → строка-описание, как у Telegram */
export function parseTgHtml(h: string): { text: string } | { error: string } {
  const stack: string[] = [];
  let text = "";
  for (let i = 0; i < h.length;) {
    const c = h[i];
    if (c === "<") {
      const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))*)\s*>/.exec(h.slice(i));
      if (!m) return { error: `Bad Request: can't parse entities: unsupported start tag at byte offset ${i}` };
      const [all, close, nameRaw, attrs] = m;
      const name = nameRaw.toLowerCase();
      if (!TG_TAGS.has(name)) return { error: `Bad Request: can't parse entities: unsupported start tag "${name}" at byte offset ${i}` };
      if (close) {
        if (attrs.trim()) return { error: `Bad Request: can't parse entities: unexpected end tag at byte offset ${i}` };
        const open = stack.pop();
        if (open !== name) return { error: `Bad Request: can't parse entities: unmatched end tag at byte offset ${i}, expected "</${open ?? "?"}>", found "</${name}>"` };
      } else {
        if (name === "a" && !/\shref\s*=/.test(attrs)) return { error: `Bad Request: can't parse entities: tag "a" must have attribute "href" at byte offset ${i}` };
        stack.push(name);
      }
      i += all.length;
      continue;
    }
    if (c === "&") {
      const m = /^&(lt|gt|amp|quot|#\d{1,7}|#x[0-9a-fA-F]{1,6});/.exec(h.slice(i));
      if (!m) return { error: `Bad Request: can't parse entities: character '&' is reserved and must be escaped at byte offset ${i}` };
      const e = m[1];
      text += e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"'
        : String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      i += m[0].length;
      continue;
    }
    if (c === ">") return { error: `Bad Request: can't parse entities: character '>' is reserved and must be escaped at byte offset ${i}` };
    text += c;
    i++;
  }
  if (stack.length) return { error: `Bad Request: can't parse entities: can't find end tag corresponding to start tag "${stack[stack.length - 1]}"` };
  return { text };
}

/** Длина текста, как её считает Telegram: в единицах UTF-16 */
const tgLength = (s: string) => s.length;

class ApiError extends Error {
  constructor(public code: number, public description: string) { super(description); }
}

/** Проверка reply_markup: inline_keyboard, у кнопки текст и ровно одно из url / callback_data (1–64 байт) */
function checkMarkup(m: unknown): void {
  if (m == null) return;
  const kb = (m as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(kb)) throw new ApiError(400, "Bad Request: can't parse reply keyboard markup JSON object");
  for (const row of kb) {
    if (!Array.isArray(row)) throw new ApiError(400, "Bad Request: can't parse inline keyboard button: field \"inline_keyboard\" must be an Array of Arrays");
    for (const b of row as Record<string, unknown>[]) {
      if (typeof b?.text !== "string" || b.text === "") throw new ApiError(400, "Bad Request: can't parse inline keyboard button: Text buttons are unallowed in the inline keyboard");
      const has = ["url", "callback_data"].filter((k) => b[k] !== undefined);
      if (has.length !== 1) throw new ApiError(400, "Bad Request: can't parse inline keyboard button: exactly one of url and callback_data must be specified");
      if (b.callback_data !== undefined) {
        const n = Buffer.byteLength(String(b.callback_data), "utf8");
        if (n < 1 || n > CB_MAX_BYTES) throw new ApiError(400, "Bad Request: BUTTON_DATA_INVALID");
      }
      if (b.url !== undefined && !/^https?:\/\/[^\s]+$/.test(String(b.url))) throw new ApiError(400, "Bad Request: inline keyboard button URL is invalid");
    }
  }
}

/** Видимый текст сообщения по parse_mode; нарушение ограничений → ApiError, как у Telegram */
function visibleText(text: unknown, parseMode: unknown): string {
  if (typeof text !== "string" || text.trim() === "") throw new ApiError(400, "Bad Request: message text is empty");
  let visible = text;
  if (parseMode === "HTML") {
    const p = parseTgHtml(text);
    if ("error" in p) throw new ApiError(400, p.error);
    visible = p.text;
  } else if (parseMode !== undefined) throw new ApiError(400, `Bad Request: unsupported parse_mode ${String(parseMode)}`);
  if (visible.trim() === "") throw new ApiError(400, "Bad Request: message text is empty");
  if (tgLength(visible) > TG_MAX_LEN) throw new ApiError(400, "Bad Request: message is too long");
  return visible;
}

/**
 * Поднять фейковый Bot API.
 * @param o.token    токен, с которым бот ходит (/bot<token>/…); чужой — 401
 * @param o.username username бота для getMe (TG_BOT_USERNAME)
 */
export async function startFakeBotApi(o: { token: string; username: string; botId?: number }): Promise<FakeBotApi> {
  const calls: ApiCall[] = [];
  const rejected: { path: string; why: string }[] = [];
  const queue: Record<string, unknown>[] = [];
  const delivered = new Set<number>();
  let nextUpdateId = 100_001;
  let nextMessageId = 1;
  let confirmedOffset = 0;
  let seq = 0;
  /** сообщения бота: chat_id → message_id → текущий текст и разметка (для правок) */
  const messages = new Map<number, Map<number, { text: string; markup: string }>>();
  /** ожидающие getUpdates (long poll) и ожидающие вызовов waitFor */
  const pollers = new Set<() => void>();
  const watchers = new Set<() => void>();
  const notify = () => { for (const w of [...watchers]) w(); };
  const botId = o.botId ?? 7_000_999_001;

  const record = (method: string, params: Record<string, unknown>, ok: boolean, extra: Partial<ApiCall> = {}): ApiCall => {
    const c: ApiCall = { seq: ++seq, method, params, ok, at: Date.now(), ...extra };
    calls.push(c);
    notify();
    return c;
  };

  /** Апдейты для getUpdates: update_id ≥ offset; меньшие — подтверждены (выбрасываются) */
  const take = (offset: number, limit: number) => {
    if (offset > 0) {
      confirmedOffset = Math.max(confirmedOffset, offset);
      for (let i = queue.length - 1; i >= 0; i--) if ((queue[i].update_id as number) < offset) queue.splice(i, 1);
    }
    return queue.filter((u) => (u.update_id as number) >= offset).slice(0, Math.max(1, Math.min(100, limit)));
  };

  /** Вызов метода; res — ответ этого запроса (обрыв соединения клиентом снимает long poll) */
  async function method(name: string, p: Record<string, unknown>, res: http.ServerResponse): Promise<unknown> {
    switch (name) {
      case "getMe":
        record(name, p, true);
        return { id: botId, is_bot: true, first_name: "Second opinion e2e", username: o.username, can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      case "deleteWebhook":
      case "setMyCommands":
        record(name, p, true);
        return true;
      case "getUpdates": {
        const offset = Number(p.offset ?? 0);
        const limit = Number(p.limit ?? 100);
        const timeout = Math.max(0, Math.min(50, Number(p.timeout ?? 0)));
        const call = record(name, p, true); // при поступлении: long poll может висеть до timeout
        let out = take(offset, limit);
        if (!out.length && timeout > 0) {
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => { if (done) return; done = true; clearTimeout(t); pollers.delete(wake); res.off("close", finish); resolve(); };
            const wake = () => { if (take(offset, limit).length) finish(); };
            const t = setTimeout(finish, timeout * 1000);
            pollers.add(wake);
            res.on("close", finish); // ответ ещё не отправлен — close означает обрыв (bot.stop() отменяет опрос)
          });
          // клиент ушёл (опрос отменён): апдейты не доставлены, остаются в очереди
          if (res.destroyed || res.writableEnded) return [];
          out = take(offset, limit);
        }
        for (const u of out) delivered.add(u.update_id as number);
        call.updates = out.map((u) => u.update_id as number);
        notify();
        return out;
      }
      case "sendMessage": {
        const chatId = Number(p.chat_id);
        visibleText(p.text, p.parse_mode);
        checkMarkup(p.reply_markup);
        const id = nextMessageId++;
        let m = messages.get(chatId);
        if (!m) { m = new Map(); messages.set(chatId, m); }
        m.set(id, { text: String(p.text), markup: JSON.stringify(p.reply_markup ?? null) });
        record(name, p, true, { messageId: id });
        return { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" }, from: { id: botId, is_bot: true, first_name: "Second opinion e2e", username: o.username }, text: String(p.text) };
      }
      case "editMessageText": {
        const chatId = Number(p.chat_id);
        const id = Number(p.message_id);
        const cur = messages.get(chatId)?.get(id);
        if (!cur) throw new ApiError(400, "Bad Request: message to edit not found");
        visibleText(p.text, p.parse_mode);
        checkMarkup(p.reply_markup);
        const markup = JSON.stringify(p.reply_markup ?? null);
        if (cur.text === String(p.text) && cur.markup === markup) {
          throw new ApiError(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
        }
        messages.get(chatId)!.set(id, { text: String(p.text), markup });
        record(name, p, true);
        return { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" }, text: String(p.text) };
      }
      case "answerCallbackQuery":
        if (typeof p.callback_query_id !== "string" || !p.callback_query_id) throw new ApiError(400, "Bad Request: query is too old and response timeout expired or query ID is invalid");
        if (p.text !== undefined && String(p.text).length > 200) throw new ApiError(400, "Bad Request: MESSAGE_TOO_LONG");
        record(name, p, true);
        return true;
      case "sendChatAction":
        if (p.action !== "typing") throw new ApiError(400, "Bad Request: wrong parameter action in request");
        record(name, p, true);
        return true;
      default:
        rejected.push({ path: name, why: "неизвестный метод" });
        throw new ApiError(404, "Not Found: method not found");
    }
  }

  const api: FakeBotApi = {
    root: "",
    calls, delivered, rejected, delay: null,
    push(update) {
      const u = { ...update, update_id: nextUpdateId++ };
      queue.push(u);
      for (const w of [...pollers]) w();
      return u.update_id;
    },
    lastOffset: () => confirmedOffset,
    waitFor(pred, timeoutMs, after = 0) {
      const find = () => calls.find((c) => c.seq > after && pred(c)) ?? null;
      const hit = find();
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const check = () => { const c = find(); if (c) { done(); resolve(c); } };
        const done = () => { clearTimeout(t); watchers.delete(check); };
        const t = setTimeout(() => { done(); resolve(null); }, timeoutMs);
        watchers.add(check);
      });
    },
    waitDelivered(updateId, timeoutMs) {
      if (delivered.has(updateId)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const check = () => { if (delivered.has(updateId)) { done(); resolve(true); } };
        const done = () => { clearTimeout(t); watchers.delete(check); };
        const t = setTimeout(() => { done(); resolve(false); }, timeoutMs);
        watchers.add(check);
      });
    },
    close() {
      for (const w of [...pollers]) w();
      return new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    },
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? "");
      if (!m || req.method !== "POST") { rejected.push({ path: req.url ?? "", why: `не POST /bot<token>/<method> (${req.method})` }); return send(404, { ok: false, error_code: 404, description: "Not Found" }); }
      if (m[1] !== o.token) { rejected.push({ path: m[2], why: "чужой токен" }); return send(401, { ok: false, error_code: 401, description: "Unauthorized" }); }
      let params: Record<string, unknown> = {};
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim()) {
        try { const j = JSON.parse(raw) as unknown; if (j && typeof j === "object") params = j as Record<string, unknown>; }
        catch { return send(400, { ok: false, error_code: 400, description: "Bad Request: can't parse JSON" }); }
      }
      const wait = api.delay?.(m[2], params) ?? 0;
      (wait > 0 ? sleep(wait) : Promise.resolve()).then(() => method(m[2], params, res)).then(
        (result) => send(200, { ok: true, result }),
        (e: unknown) => {
          const err = e instanceof ApiError ? e : new ApiError(500, `Internal Server Error: ${String(e)}`);
          if (m[2] !== "getUpdates") record(m[2], params, false, { error: { error_code: err.code, description: err.description } });
          send(err.code, { ok: false, error_code: err.code, description: err.description });
        },
      );
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  api.root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return api;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
