/**
 * WP-TG: фейковый Telegram (TgClient из §4.4 плана). Записывает каждый вызов, выдаёт возрастающие message_id.
 * Сеть не используется. Для TG.18 — «сырой» клиент со сценарием ошибок в форме GrammyError ({error_code, description, parameters}).
 */
import type { InlineKeyboard, TgApiError, TgClient, TgSendOpts } from "./mods";

export interface TgCall {
  n: number; method: "sendMessage" | "editMessageText" | "answerCallbackQuery" | "sendChatAction";
  chatId?: number; messageId?: number; text?: string; html?: boolean; keyboard?: InlineKeyboard; cbId?: string; action?: string;
}

export function fakeTelegram(firstId = 1000) {
  const calls: TgCall[] = [];
  let next = firstId;
  const rec = (c: Omit<TgCall, "n">) => { const x = { ...c, n: calls.length } as TgCall; calls.push(x); return x; };
  const opts = (o?: TgSendOpts) => ({ ...(o?.html !== undefined ? { html: !!o.html } : {}), ...(o?.keyboard ? { keyboard: o.keyboard } : {}) });
  const client: TgClient = {
    async sendMessage(chatId, text, o) { const id = next++; rec({ method: "sendMessage", chatId, text, messageId: id, ...opts(o) }); return { message_id: id }; },
    async editMessageText(chatId, messageId, text, o) { rec({ method: "editMessageText", chatId, messageId, text, ...opts(o) }); },
    async answerCallbackQuery(id, text) { rec({ method: "answerCallbackQuery", cbId: id, text }); },
    async sendChatAction(chatId, action) { rec({ method: "sendChatAction", chatId, action }); },
  };
  /** Сообщения бота в чате с клавиатурой (последняя версия по message_id). Как в Bot API: editMessageText без reply_markup
   *  СНИМАЕТ inline-клавиатуру — кнопку, которой у пользователя уже нет, нажать нельзя */
  const keyboards = (chatId: number) => {
    const byId = new Map<number, InlineKeyboard | undefined>();
    for (const c of calls) {
      if (c.chatId !== chatId || c.messageId == null) continue;
      if (c.method === "sendMessage" || c.method === "editMessageText") byId.set(c.messageId, c.keyboard);
    }
    return [...byId.entries()].filter(([, k]) => k && k.inline_keyboard.some((r) => r.length)).map(([messageId, keyboard]) => ({ messageId, keyboard: keyboard! }));
  };
  const visible = (chatId?: number) => calls.filter((c) => c.method !== "sendChatAction" && (chatId == null || c.chatId === chatId));
  return { client, calls, keyboards, visible };
}

/** Ошибка Bot API в форме GrammyError: Error + error_code / description / parameters */
export function apiError(e: TgApiError, message?: string): Error & TgApiError {
  return Object.assign(new Error(message ?? `Call to 'sendMessage' failed! (${e.error_code}: ${e.description})`), {
    name: "GrammyError", ok: false, method: "sendMessage", ...e,
  });
}

/** Сырой клиент для TG.18: каждый вызов sendMessage берёт следующий шаг сценария (ошибка или null — успех); вызовы записываются */
export function scriptedRaw(script: Array<Error | null>) {
  const calls: Array<{ method: string; text: string; html: boolean }> = [];
  let i = 0;
  let id = 5000;
  const step = () => { const s = i < script.length ? script[i] : script[script.length - 1] ?? null; i++; if (s) throw s; };
  const client: TgClient = {
    async sendMessage(_chatId, text, o) { calls.push({ method: "sendMessage", text, html: !!o?.html }); step(); return { message_id: id++ }; },
    async editMessageText(_chatId, _mid, text, o) { calls.push({ method: "editMessageText", text, html: !!o?.html }); step(); },
    async answerCallbackQuery() { calls.push({ method: "answerCallbackQuery", text: "", html: false }); },
    async sendChatAction() { calls.push({ method: "sendChatAction", text: "", html: false }); },
  };
  return { client, calls };
}
