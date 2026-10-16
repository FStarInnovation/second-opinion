/**
 * Транспорт Bot API (план WP-TG §3 решение 2, §4.4, §4.7). grammY нужен только здесь (тип Api) и в main.ts.
 *  - TgClient — то, чем ядро ходит в Telegram (четыре метода); в харнесе его заменяет фейк.
 *  - withTelegramPolicy — своя обёртка вместо плагина auto-retry: 429 → пауза retry_after и повтор (не больше 3 раз);
 *    400 «can't parse entities» → тот же текст без HTML (htmlToPlain), клавиатура сохраняется, событие пишется в журнал;
 *    правка тем же текстом (400 «message is not modified») — не ошибка. Прочие ошибки уходят вызывающему (ядро их журналирует).
 *    sendChatAction (typing) — без повторов: индикатор «как получится», повтор после паузы retry_after пережил бы ход и
 *    множил бы вызовы под флуд-контролем (следующий тик typing через 4 с всё равно обновит индикатор).
 *  - grammyClient — TgClient поверх grammY Api: parse_mode HTML по флагу, превью ссылок выключено.
 *  - tgErrorInfo — форма ошибки (GrammyError: error_code/description/parameters; HttpError — сеть) без текста ошибки целиком:
 *    в тексте HttpError бывает URL с токеном.
 */
import type { Api } from "grammy";
import { htmlToPlain } from "./html";
import type { LogRec } from "./log";

export type InlineKeyboard = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
export interface TgSendOpts { html?: boolean; keyboard?: InlineKeyboard }
export interface TgClient {
  sendMessage(chatId: number, text: string, o?: TgSendOpts): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, o?: TgSendOpts): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action: "typing"): Promise<void>;
}
/** Форма GrammyError */
export interface TgApiError { error_code: number; description: string; parameters?: { retry_after?: number } }

/** Сколько раз повторять после 429 */
const MAX_429_RETRIES = 3;

/** Код и описание ошибки Bot API (GrammyError) или сетевой (HttpError и прочие: code null). short — для журнала, без URL */
export function tgErrorInfo(e: unknown): { code: number | null; description: string; retryAfter: number | null; short: string } {
  const o = (e && typeof e === "object" ? e : {}) as Partial<TgApiError> & { name?: unknown; error?: unknown; cause?: unknown };
  if (typeof o.error_code === "number") {
    const description = typeof o.description === "string" ? o.description : "";
    const ra = o.parameters?.retry_after;
    return { code: o.error_code, description, retryAfter: typeof ra === "number" && ra >= 0 ? ra : null, short: description.slice(0, 120) };
  }
  const inner = (o.error ?? o.cause) as { code?: unknown } | undefined;
  const code = inner && typeof inner === "object" && typeof inner.code === "string" ? ` ${inner.code}` : "";
  const name = typeof o.name === "string" ? o.name : "Error";
  return { code: null, description: "", retryAfter: null, short: `${name}${code}` };
}

const cantParse = (d: string) => /can't parse entities/i.test(d);
const notModified = (d: string) => /message is not modified/i.test(d);

/** Политика вызовов Bot API поверх любого TgClient (main.ts — grammyClient; харнес — фейк) */
export function withTelegramPolicy(raw: TgClient, d: { sleep(ms: number): Promise<void>; log(r: LogRec): void }): TgClient {
  const log = (r: LogRec) => { try { d.log(r); } catch { /* журнал не роняет вызов */ } };
  /** Вызов с повтором после 429 и откатом HTML → простой текст; op получает текст и опции текущей попытки */
  async function call<T>(text: string | null, o: TgSendOpts | undefined, op: (text: string | null, o: TgSendOpts | undefined) => Promise<T>): Promise<T> {
    let retries = 0;
    let curText = text;
    let curOpts = o;
    for (;;) {
      try {
        return await op(curText, curOpts);
      } catch (e) {
        const info = tgErrorInfo(e);
        if (info.code === 429 && retries < MAX_429_RETRIES) {
          retries++;
          await d.sleep(Math.max(1, info.retryAfter ?? 1) * 1000);
          continue;
        }
        if (info.code === 400 && curOpts?.html && curText != null && cantParse(info.description)) {
          log({ ev: "tg_plain_fallback", status: "400" });
          curText = htmlToPlain(curText);
          curOpts = curOpts.keyboard ? { keyboard: curOpts.keyboard } : undefined;
          continue;
        }
        throw e;
      }
    }
  }
  return {
    sendMessage: (chatId, text, o) => call(text, o, (t, oo) => raw.sendMessage(chatId, t ?? "", oo)),
    editMessageText: async (chatId, messageId, text, o) => {
      try {
        await call(text, o, (t, oo) => raw.editMessageText(chatId, messageId, t ?? "", oo));
      } catch (e) {
        const info = tgErrorInfo(e);
        if (info.code === 400 && notModified(info.description)) return; // уже показано то же самое
        throw e;
      }
    },
    answerCallbackQuery: (id, text) => call(null, undefined, () => raw.answerCallbackQuery(id, text)),
    sendChatAction: (chatId, action) => raw.sendChatAction(chatId, action), // без повторов 429: см. шапку
  };
}

type SendOther = NonNullable<Parameters<Api["sendMessage"]>[2]>;
type EditOther = NonNullable<Parameters<Api["editMessageText"]>[3]>;
type Markup = NonNullable<SendOther["reply_markup"]>;

/** Клавиатура TgClient → reply_markup Bot API: у кнопки ровно одно из url / callback_data */
function markup(k: InlineKeyboard | undefined): Markup | undefined {
  if (!k) return undefined;
  return {
    inline_keyboard: k.inline_keyboard.map((row) => row.map((b) => (b.url != null ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callback_data ?? "" }))),
  } as Markup;
}

/** TgClient поверх grammY: parse_mode HTML по флагу html, превью ссылок выключено, клавиатура — reply_markup */
export function grammyClient(api: Api): TgClient {
  const other = (o?: TgSendOpts): SendOther & EditOther => {
    const out: Record<string, unknown> = { link_preview_options: { is_disabled: true } };
    if (o?.html) out.parse_mode = "HTML";
    const m = markup(o?.keyboard);
    if (m) out.reply_markup = m;
    return out as SendOther & EditOther;
  };
  return {
    async sendMessage(chatId, text, o) {
      const m = await api.sendMessage(chatId, text, other(o));
      return { message_id: m.message_id };
    },
    async editMessageText(chatId, messageId, text, o) {
      await api.editMessageText(chatId, messageId, text, other(o));
    },
    async answerCallbackQuery(id, text) {
      await api.answerCallbackQuery(id, text ? { text } : undefined);
    },
    async sendChatAction(chatId, action) {
      await api.sendChatAction(chatId, action);
    },
  };
}
