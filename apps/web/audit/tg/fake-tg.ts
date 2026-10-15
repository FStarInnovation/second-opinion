/**
 * WP-TG: фейковый Telegram — реализация TgClient (§4.4) для ядра бота в харнесе (§6 «Фейковый Telegram»).
 *  - Записывает ВСЕ вызовы по порядку (`calls`, сквозной `seq`), включая упавшие (поле `error`).
 *  - `sendMessage` выдаёт возрастающие message_id (сквозные на экземпляр, с 1001); у упавшего вызова id нет.
 *  - Хранит текущее состояние каждого сообщения бота (текст, html, клавиатура) с учётом правок: `messages(chatId)`.
 *  - `editMessageText` по message_id, которого фейк не выдавал этому чату, бросает 400 «message to edit not found», как Telegram.
 *    Правило «message is not modified» (правка тем же текстом) НЕ моделируется.
 *  - Внедрение ошибок (TG.18): `inject({ method, error, times?, when? })` — следующие подходящие вызовы бросают заданную ошибку.
 *    Ошибки — по форме grammY: `tgError(code, description, retryAfter?)` (GrammyError: error_code/description/parameters)
 *    и `httpError(method)` (HttpError: сеть). Готовые: `TG_ERRORS.blocked()`, `.editNotFound()`, `.cantParse()`, `.tooMany(s)`.
 *
 * Пример: `const tg = new FakeTg(); tg.inject({ method: "sendMessage", error: TG_ERRORS.blocked() }); createCore({ tg, … })`.
 */
import type { InlineKeyboard, TgApiError, TgClient, TgSendOpts } from "./types";

export type TgMethod = "sendMessage" | "editMessageText" | "answerCallbackQuery" | "sendChatAction";

interface CallBase { seq: number; method: TgMethod; error?: TgFakeError }
export type TgCall =
  | (CallBase & { method: "sendMessage"; chatId: number; text: string; opts?: TgSendOpts; messageId?: number })
  | (CallBase & { method: "editMessageText"; chatId: number; messageId: number; text: string; opts?: TgSendOpts })
  | (CallBase & { method: "answerCallbackQuery"; callbackId: string; text?: string })
  | (CallBase & { method: "sendChatAction"; chatId: number; action: "typing" });

/** Состояние сообщения бота после всех правок */
export interface TgMessageState { chatId: number; messageId: number; text: string; html: boolean; keyboard?: InlineKeyboard; edits: number; seq: number }

/** GrammyError: `error_code`, `description`, `parameters`, `method`, `ok:false` (как в grammY) */
export class FakeGrammyError extends Error implements TgApiError {
  readonly ok = false as const;
  name = "GrammyError";
  method = "";
  parameters: { retry_after?: number };
  constructor(public error_code: number, public description: string, parameters: { retry_after?: number } = {}) {
    super(`Call failed! (${error_code}: ${description})`);
    this.parameters = parameters;
  }
}
/** HttpError grammY: сеть недоступна; `error` — исходная причина */
export class FakeHttpError extends Error {
  name = "HttpError";
  constructor(method: string, public error: unknown = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" })) {
    super(`Network request for '${method}' failed!`);
  }
}
export type TgFakeError = FakeGrammyError | FakeHttpError | Error;

/** Ошибка Bot API в форме GrammyError */
export const tgError = (code: number, description: string, retryAfter?: number): FakeGrammyError =>
  new FakeGrammyError(code, description, retryAfter != null ? { retry_after: retryAfter } : {});
/** Сетевая ошибка в форме HttpError grammY */
export const httpError = (method: TgMethod | string = "sendMessage"): FakeHttpError => new FakeHttpError(method);

/** Готовые ошибки для TG.18 (каждый вызов — новый объект) */
export const TG_ERRORS = {
  blocked: () => tgError(403, "Forbidden: bot was blocked by the user"),
  editNotFound: () => tgError(400, "Bad Request: message to edit not found"),
  cantEdit: () => tgError(400, "Bad Request: message can't be edited"),
  cantParse: () => tgError(400, "Bad Request: can't parse entities: Unsupported start tag \"x\" at byte offset 0"),
  tooMany: (retryAfter = 3) => tgError(429, `Too Many Requests: retry after ${retryAfter}`, retryAfter),
  network: (method: TgMethod = "sendMessage") => httpError(method),
} as const;

/** Правило внедрения ошибки: метод, ошибка (или фабрика), сколько раз (по умолчанию 1; Infinity — всегда), фильтр по вызову */
export interface InjectRule {
  method: TgMethod;
  error: TgFakeError | ((call: TgCall) => TgFakeError);
  times?: number;
  when?: (call: TgCall) => boolean;
}

export class FakeTg implements TgClient {
  /** Все вызовы по порядку (и упавшие — с полем error) */
  readonly calls: TgCall[] = [];
  private seq = 0;
  private nextId: number;
  private readonly rules: (InjectRule & { left: number })[] = [];
  private readonly state = new Map<string, TgMessageState>();

  constructor(o: { firstMessageId?: number } = {}) {
    this.nextId = o.firstMessageId ?? 1001;
  }

  /** Внедрить ошибку в следующие подходящие вызовы. Возвращает this (цепочка) */
  inject(rule: InjectRule): this {
    this.rules.push({ ...rule, left: rule.times ?? 1 });
    return this;
  }
  /** Снять все правила ошибок */
  clearInjections(): void { this.rules.length = 0; }
  /** Сколько раз ещё сработает каждое правило (для detail) */
  pendingInjections(): { method: TgMethod; left: number }[] { return this.rules.map((r) => ({ method: r.method, left: r.left })); }

  private check(call: TgCall): void {
    const r = this.rules.find((x) => x.left > 0 && x.method === call.method && (!x.when || x.when(call)));
    if (!r) return;
    r.left -= 1;
    const err = typeof r.error === "function" ? r.error(call) : r.error;
    if (err instanceof FakeGrammyError) err.method = call.method;
    call.error = err;
    throw err;
  }
  private key = (chatId: number, messageId: number) => `${chatId}:${messageId}`;
  private copyOpts = (o?: TgSendOpts): TgSendOpts | undefined => (o ? (JSON.parse(JSON.stringify(o)) as TgSendOpts) : undefined);

  async sendMessage(chatId: number, text: string, o?: TgSendOpts): Promise<{ message_id: number }> {
    const call: TgCall = { seq: ++this.seq, method: "sendMessage", chatId, text, ...(o ? { opts: this.copyOpts(o) } : {}) };
    this.calls.push(call);
    this.check(call);
    const message_id = this.nextId++;
    call.messageId = message_id;
    this.state.set(this.key(chatId, message_id), {
      chatId, messageId: message_id, text, html: !!o?.html, keyboard: this.copyOpts(o)?.keyboard, edits: 0, seq: call.seq,
    });
    return { message_id };
  }

  async editMessageText(chatId: number, messageId: number, text: string, o?: TgSendOpts): Promise<void> {
    const call: TgCall = { seq: ++this.seq, method: "editMessageText", chatId, messageId, text, ...(o ? { opts: this.copyOpts(o) } : {}) };
    this.calls.push(call);
    this.check(call);
    const st = this.state.get(this.key(chatId, messageId));
    if (!st) {
      const err = TG_ERRORS.editNotFound();
      err.method = "editMessageText";
      call.error = err;
      throw err;
    }
    st.text = text;
    st.html = !!o?.html;
    st.keyboard = this.copyOpts(o)?.keyboard; // как Telegram: правка без reply_markup снимает клавиатуру
    st.edits += 1;
    st.seq = call.seq;
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    const call: TgCall = { seq: ++this.seq, method: "answerCallbackQuery", callbackId: id, ...(text !== undefined ? { text } : {}) };
    this.calls.push(call);
    this.check(call);
  }

  async sendChatAction(chatId: number, action: "typing"): Promise<void> {
    const call: TgCall = { seq: ++this.seq, method: "sendChatAction", chatId, action };
    this.calls.push(call);
    this.check(call);
  }

  /* ───── чтение записи ───── */

  /** Вызовы, начиная с индекса (для «что сделал бот на этот апдейт»: `const n = tg.calls.length; …; tg.callsSince(n)`) */
  callsSince(index: number): TgCall[] { return this.calls.slice(index); }
  /** Успешные вызовы, без sendChatAction (typing недетерминирован по таймеру) */
  visibleCalls(from = 0): TgCall[] { return this.calls.slice(from).filter((c) => !c.error && c.method !== "sendChatAction"); }
  /** Текущее состояние сообщений бота в чате (по порядку отправки) */
  messages(chatId: number): TgMessageState[] {
    return [...this.state.values()].filter((m) => m.chatId === chatId).sort((a, b) => a.messageId - b.messageId);
  }
  /** Последнее (по message_id) сообщение бота в чате, у которого сейчас есть inline-клавиатура */
  lastWithKeyboard(chatId: number): TgMessageState | undefined {
    return this.messages(chatId).filter((m) => m.keyboard?.inline_keyboard?.some((row) => row.length > 0)).pop();
  }
  /** Сводка вызовов одной строкой для detail: `send#1001(«…») → edit#1001(html «…») → answer(«…»)` */
  summary(from = 0, max = 60): string {
    const cut = (s: string) => { const t = s.replace(/\s+/g, " "); return t.length > max ? t.slice(0, max - 1) + "…" : t; };
    return this.calls.slice(from).map((c) => {
      const err = c.error ? ` ✗${(c.error as { error_code?: number }).error_code ?? c.error.name}` : "";
      switch (c.method) {
        case "sendMessage": return `send#${c.messageId ?? "-"}(${c.opts?.html ? "html " : ""}«${cut(c.text)}»${c.opts?.keyboard ? ` +кнопок ${c.opts.keyboard.inline_keyboard.flat().length}` : ""})${err}`;
        case "editMessageText": return `edit#${c.messageId}(${c.opts?.html ? "html " : ""}«${cut(c.text)}»)${err}`;
        case "answerCallbackQuery": return `answer(${c.text !== undefined ? `«${cut(c.text)}»` : ""})${err}`;
        case "sendChatAction": return `typing${err}`;
      }
    }).join(" → ");
  }
}
