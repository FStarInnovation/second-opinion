/**
 * WP-TG: эталон диалогов и действия пользователя → апдейты Telegram (§6 «Действия диалога → апдейты Telegram»).
 *
 *  - `loadDialogs()` / `loadDialog("d3")` — фикстуры apps/web/audit/fixtures/dialogs/dN.json (7 диалогов, 15 запросов).
 *  - Апдейты собираются в форме СЫРОГО апдейта Bot API (как присылает Telegram), а не урезанного TgUpdate: в `from`, `chat`,
 *    `callback_query.from` и `callback_query.message.chat` есть username / first_name / last_name со значениями-маркерами
 *    `NAME_MARKERS` (TG.20); как в настоящем private-чате, `chat.id === from.id`. Тип `RawUpdate` присваивается `TgUpdate`
 *    (передавайте переменной — лишние поля допустимы).
 *  - Соответствие действий (§6):
 *      type:X              → message с текстом X;
 *      open:/chat?m=X      → message с текстом X (значение параметра m, как его раскодирует URLSearchParams);
 *      open:/chat?q=…      → message «/start <encodeStartPayload(параметры)>» — через переданный модуль @so/present/entry;
 *      pick:i              → callback_query с callback_data i-й кнопки (среди кнопок с callback_data, по строкам слева направо)
 *                            последнего сообщения бота с клавиатурой — из записи FakeTg. Так проверяется и сама клавиатура.
 *  - Диалогу dK даётся длинный отличимый chat_id = 7000000100 + K (`dialogChatId`).
 */
import fs from "node:fs";
import path from "node:path";
import { AUDIT_FIXTURES } from "../lib";
import type { FakeTg } from "./fake-tg";
import { tgPlain } from "./normalize";
import type { BotCore, DialogAction, DialogFixture, EntryMod, EntryParams, TgUpdate } from "./types";

/* ═══════════════════════════ фикстуры диалогов ═══════════════════════════ */

export const DIALOGS_DIR = path.join(AUDIT_FIXTURES, "dialogs");
export const DIALOG_IDS = ["d1", "d2", "d3", "d4", "d5", "d6", "d7"] as const;
export type DialogId = (typeof DIALOG_IDS)[number];

const cache = new Map<string, DialogFixture>();
/** Фикстура dN.json (копия — правьте свободно) */
export function loadDialog(id: DialogId | string): DialogFixture {
  let d = cache.get(id);
  if (!d) {
    d = JSON.parse(fs.readFileSync(path.join(DIALOGS_DIR, `${id}.json`), "utf8")) as DialogFixture;
    if (d.id !== id) throw new Error(`фикстура ${id}.json: внутри id=${d.id}`);
    cache.set(id, d);
  }
  return JSON.parse(JSON.stringify(d)) as DialogFixture;
}
/** Все 7 диалогов по порядку d1…d7 */
export const loadDialogs = (): DialogFixture[] => DIALOG_IDS.map((id) => loadDialog(id));

/** Пара «запрос k → запрос k+1 того же диалога» (для TG.G2: ответ на k ≡ сообщение ассистента в теле k+1); всего 8 */
export interface DialogPair { dialog: string; k: number; req: DialogFixture["requests"][number]; next: DialogFixture["requests"][number] }
export function dialogPairs(ds: DialogFixture[] = loadDialogs()): DialogPair[] {
  return ds.flatMap((d) => d.requests.slice(0, -1).map((req, k) => ({ dialog: d.id, k, req, next: d.requests[k + 1] })));
}

/** Текст последней реплики пользователя в теле запроса */
export function lastUserText(body: { messages?: { role?: string; parts?: { type?: string; text?: string }[] }[] }): string {
  const ms = (body.messages ?? []).filter((m) => m.role === "user");
  return (ms[ms.length - 1]?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ");
}

/* ═══════════════════════════ сырые апдейты Telegram ═══════════════════════════ */

/** Маркеры имён собеседника (TG.20): ни один не должен попасть в журналы бота и usage.jsonl */
export const NAME_MARKERS = { username: "zz_user_marker", first_name: "Zzfirstmarker", last_name: "Zzlastmarker" } as const;
/** chat_id диалога dK (K = 1…7): 7000000100 + K; в private-чате from.id = chat.id */
export const dialogChatId = (k: number): number => 7000000100 + k;
/** chat_id по id диалога («d3» → 7000000103) */
export const chatIdOf = (d: DialogFixture | string): number => dialogChatId(Number((typeof d === "string" ? d : d.id).replace(/^d/, "")));
/** Регэксп поиска id как отдельного числа: `(?<![0-9])<id>(?![0-9])` (TG.20) */
export const idRegex = (id: number | string): RegExp => new RegExp(`(?<![0-9])${String(id)}(?![0-9])`);

/** id бота в сырых апдейтах (callback_query.message.from) */
export const FAKE_BOT_USER = { id: 7999999999, is_bot: true, first_name: "Second opinion", username: "so_audit_test_bot" } as const;

export interface RawUser { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string; language_code?: string }
export interface RawChat { id: number; type: string; first_name?: string; last_name?: string; username?: string; title?: string }
export interface RawMessage {
  message_id: number; date: number; chat: RawChat; from?: RawUser; text?: string;
  entities?: { type: string; offset: number; length: number }[];
  photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[];
  voice?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string };
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string };
  reply_markup?: unknown;
}
export interface RawCallbackQuery { id: string; from: RawUser; chat_instance: string; data?: string; message?: RawMessage }
/** Сырой апдейт Bot API; присваивается TgUpdate (§4.4) */
export interface RawUpdate { update_id: number; message?: RawMessage; callback_query?: RawCallbackQuery }
// compile-time: сырой апдейт годится как TgUpdate
const _rawIsTgUpdate = (u: RawUpdate): TgUpdate => u;
void _rawIsTgUpdate;

export interface UpdateOpts {
  /** тип чата (по умолчанию "private"); для group/supergroup chat.id = −(1e12 + chatId), title вместо имён */
  chatType?: "private" | "group" | "supergroup" | "channel";
  /** маркеры имён в from/chat (по умолчанию true) */
  markers?: boolean;
}

/**
 * Генератор сырых апдейтов: сквозные update_id (с firstUpdateId), message_id пользователя, детерминированная date.
 * Один экземпляр на прогон; update_id никогда не повторяются (для дубля — передайте тот же объект апдейта повторно).
 */
export class UpdateFactory {
  private updateId: number;
  private userMsgId: number;
  private cbId = 0;
  private readonly date0 = 1_760_500_000; // 15.10.2026, секунды

  constructor(o: { firstUpdateId?: number; firstMessageId?: number } = {}) {
    this.updateId = o.firstUpdateId ?? 500_000_001;
    this.userMsgId = o.firstMessageId ?? 1;
  }

  user(id: number, markers = true): RawUser {
    return markers
      ? { id, is_bot: false, first_name: NAME_MARKERS.first_name, last_name: NAME_MARKERS.last_name, username: NAME_MARKERS.username, language_code: "ru" }
      : { id, is_bot: false, first_name: "U", language_code: "ru" };
  }
  chat(id: number, o: UpdateOpts = {}): RawChat {
    const type = o.chatType ?? "private";
    if (type !== "private") return { id: -(1_000_000_000_000 + id), type, title: "Audit group" };
    return o.markers === false ? { id, type } : { id, type, first_name: NAME_MARKERS.first_name, last_name: NAME_MARKERS.last_name, username: NAME_MARKERS.username };
  }
  private nextUpdate = () => this.updateId++;

  /** Текстовое сообщение (команды /start, /new, /help получают entities bot_command, как в Telegram) */
  message(chatId: number, text: string, o: UpdateOpts = {}): RawUpdate {
    const id = this.nextUpdate();
    const cmd = text.match(/^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?/);
    return {
      update_id: id,
      message: {
        message_id: this.userMsgId++, date: this.date0 + (id % 100_000), chat: this.chat(chatId, o), from: this.user(chatId, o.markers !== false), text,
        ...(cmd ? { entities: [{ type: "bot_command", offset: 0, length: cmd[0].length }] } : {}),
      },
    };
  }
  /** Не текст: фото, голос, документ (TG.19: BOT.onlyText без POST) */
  nonText(chatId: number, kind: "photo" | "voice" | "document", o: UpdateOpts = {}): RawUpdate {
    const id = this.nextUpdate();
    const media =
      kind === "photo" ? { photo: [{ file_id: "AgAD-audit-photo", file_unique_id: "AQAD-p", width: 90, height: 90, file_size: 1024 }] }
      : kind === "voice" ? { voice: { file_id: "AwAD-audit-voice", file_unique_id: "AQAD-v", duration: 2, mime_type: "audio/ogg" } }
      : { document: { file_id: "BQAD-audit-doc", file_unique_id: "AQAD-d", file_name: "offer.pdf", mime_type: "application/pdf" } };
    return { update_id: id, message: { message_id: this.userMsgId++, date: this.date0 + (id % 100_000), chat: this.chat(chatId, o), from: this.user(chatId, o.markers !== false), ...media } };
  }
  /**
   * Нажатие inline-кнопки: callback_query с data и сообщением бота, к которому прикреплена кнопка.
   * @param msg message_id и текст сообщения бота (берите из FakeTg: `tg.lastWithKeyboard(chatId)`)
   */
  callback(chatId: number, data: string, msg: { messageId: number; text?: string }, o: UpdateOpts = {}): RawUpdate {
    const id = this.nextUpdate();
    return {
      update_id: id,
      callback_query: {
        id: `cbq-audit-${++this.cbId}`, from: this.user(chatId, o.markers !== false), chat_instance: "-4242424242424242424", data,
        message: { message_id: msg.messageId, date: this.date0 + (id % 100_000), chat: this.chat(chatId, o), from: { ...FAKE_BOT_USER }, ...(msg.text !== undefined ? { text: msg.text } : {}) },
      },
    };
  }
}

/* ═══════════════════════════ действие диалога → апдейт ═══════════════════════════ */

/** Параметры EntryParams из ссылки /chat?q=…&promised=…&pos=…&k=…&price=… (строки, как в URL; только заданные ключи) */
export function entryParamsOf(url: string): EntryParams {
  const sp = new URL(url, "http://127.0.0.1").searchParams;
  const out: EntryParams = {};
  for (const k of ["q", "promised", "pos", "k", "price", "m"] as const) {
    const v = sp.get(k);
    if (v != null) out[k] = v;
  }
  return out;
}

export type ActionUpdate =
  | { ok: true; update: RawUpdate; kind: "message" | "callback"; text?: string; data?: string; note: string }
  | { ok: false; detail: string };

export interface ActionCtx {
  chatId: number;
  tg: FakeTg;
  factory: UpdateFactory;
  /** @so/present/entry — нужен только для open:/chat?q=… (encodeStartPayload); нет модуля → ok:false с detail */
  entry?: EntryMod | null;
  opts?: UpdateOpts;
}

/** Действие эталона → сырой апдейт по §6. Никогда не бросает: неудача — `{ok:false, detail}` (для fail(detail)) */
export function actionToUpdate(a: DialogAction, ctx: ActionCtx): ActionUpdate {
  const { chatId, factory } = ctx;
  if (a.kind === "type") return { ok: true, kind: "message", update: factory.message(chatId, a.text, ctx.opts), text: a.text, note: `type «${a.text}»` };
  if (a.kind === "open") {
    const p = entryParamsOf(a.url);
    if (p.q != null && p.q !== "") {
      if (!ctx.entry) return { ok: false, detail: `действие open ${a.url}: нужен @so/present/entry (encodeStartPayload) — модуля нет` };
      const { m: _m, ...qp } = p; // m в deep-link не кодируется (§4.6); при q браузер m не смотрит
      void _m;
      let payload: string | null;
      try { payload = ctx.entry.encodeStartPayload(qp); } catch (e) { return { ok: false, detail: `encodeStartPayload(${JSON.stringify(qp)}) бросил: ${String(e).slice(0, 160)}` }; }
      if (payload == null) return { ok: false, detail: `encodeStartPayload(${JSON.stringify(qp)}) вернул null — ссылку ${a.url} нельзя открыть в боте` };
      const text = `/start ${payload}`;
      return { ok: true, kind: "message", update: factory.message(chatId, text, ctx.opts), text, note: `open ${a.url} → «${text}»` };
    }
    if (p.m != null) return { ok: true, kind: "message", update: factory.message(chatId, p.m, ctx.opts), text: p.m, note: `open ${a.url} → «${p.m}»` };
    return { ok: false, detail: `действие open ${a.url}: нет ни q, ни m` };
  }
  const msg = ctx.tg.lastWithKeyboard(chatId);
  if (!msg?.keyboard) return { ok: false, detail: `pick:${a.index}: у бота в чате ${chatId} нет сообщения с inline-клавиатурой (ожидалась клавиатура выбора выпуска pk:…); вызовы Telegram: ${ctx.tg.summary()}` };
  const buttons = msg.keyboard.inline_keyboard.flat().filter((b) => b.callback_data != null);
  const b = buttons[a.index];
  if (!b) return { ok: false, detail: `pick:${a.index}: в клавиатуре сообщения #${msg.messageId} кнопок с callback_data ${buttons.length} (${buttons.map((x) => `«${x.text}»→${x.callback_data}`).join(", ").slice(0, 300)})` };
  return {
    ok: true, kind: "callback", data: b.callback_data,
    update: factory.callback(chatId, b.callback_data!, { messageId: msg.messageId, text: msg.html ? tgPlain(msg.text) : msg.text }, ctx.opts),
    note: `pick:${a.index} → кнопка «${b.text}» (${b.callback_data}) сообщения #${msg.messageId}`,
  };
}

/* ═══════════════════════════ прогон диалога через ядро бота ═══════════════════════════ */

export interface PlayStep {
  action: number;
  a: DialogAction;
  note: string;
  update: RawUpdate;
  /** индексы tg.calls до и после хода: `tg.calls.slice(callsFrom, callsTo)` — что сделал бот на это действие */
  callsFrom: number;
  callsTo: number;
  ms: number;
}
export interface PlayResult { ok: boolean; steps: PlayStep[]; detail?: string }

/**
 * Проиграть действия диалога через ядро: на каждое действие — апдейт (actionToUpdate), `await core.handleUpdate(u)`,
 * затем `await core.idle()`. Останавливается на первом действии, которое нельзя превратить в апдейт (ok:false, detail).
 * POST-ы бота в сервер не считает — их видно в `Server.calls` (scenarios.ts, loadServer) или в своём fetch.
 * @param o.chatId   по умолчанию chatIdOf(d) = 7000000100 + K
 * @param o.factory  общий генератор апдейтов (для сквозных update_id между диалогами)
 * @param o.afterStep вызывается после каждого хода (например, снять peek(chatId) для TG.5)
 */
export async function playDialog(core: BotCore, tg: FakeTg, d: DialogFixture, o: {
  chatId?: number; entry?: EntryMod | null; factory?: UpdateFactory; opts?: UpdateOpts; afterStep?: (s: PlayStep) => void | Promise<void>;
} = {}): Promise<PlayResult> {
  const chatId = o.chatId ?? chatIdOf(d);
  const factory = o.factory ?? new UpdateFactory();
  const steps: PlayStep[] = [];
  for (let i = 0; i < d.actions.length; i++) {
    const a = d.actions[i];
    const u = actionToUpdate(a, { chatId, tg, factory, entry: o.entry, opts: o.opts });
    if (!u.ok) return { ok: false, steps, detail: `${d.id}, действие ${i}: ${u.detail}` };
    const callsFrom = tg.calls.length;
    const t0 = Date.now();
    const upd: TgUpdate = u.update;
    await core.handleUpdate(upd);
    await core.idle();
    const s: PlayStep = { action: i, a, note: u.note, update: u.update, callsFrom, callsTo: tg.calls.length, ms: Date.now() - t0 };
    steps.push(s);
    await o.afterStep?.(s);
  }
  return { ok: true, steps };
}
