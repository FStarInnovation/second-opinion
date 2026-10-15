/**
 * WP-TG: эталон паритета (apps/web/audit/fixtures/dialogs/*.json — 7 диалогов, 15 реальных тел assistant-ui, запись 14.10)
 * и перевод действий пользователя сайта в апдейты Telegram (§6 плана):
 *   type:X, open:/chat?m=X  → message с текстом X;
 *   open:/chat?q=…          → message "/start " + encodeStartPayload(параметры ссылки);
 *   pick:i                  → callback_query с callback_data i-й кнопки последнего сообщения бота с клавиатурой.
 * Тестовые апдейты несут username, имя и фамилию (как настоящие) — TG.20 проверяет, что они никуда не попадают.
 */
import fs from "node:fs";
import path from "node:path";
import { AUDIT_FIXTURES } from "../lib";
import type { EntryParams, TgUpdate, UIMsg } from "./mods";

export interface WireRequest { headers: Record<string, string>; body: Record<string, unknown> & { id?: string; messages?: UIMsg[]; inputs?: unknown } }
export interface Dialog { name: string; description: string; actions: string[]; requests: WireRequest[] }

export const DIALOGS_DIR = path.join(AUDIT_FIXTURES, "dialogs");
export function loadDialogs(): Dialog[] {
  return fs.readdirSync(DIALOGS_DIR).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIALOGS_DIR, f), "utf8")) as Dialog);
}

export type Action =
  | { kind: "type"; text: string; raw: string }
  | { kind: "open-m"; text: string; raw: string }
  | { kind: "open-q"; params: EntryParams; raw: string }
  | { kind: "pick"; i: number; raw: string };

export function parseAction(raw: string): Action {
  if (raw.startsWith("type:")) return { kind: "type", text: raw.slice(5), raw };
  if (raw.startsWith("pick:")) return { kind: "pick", i: Number(raw.slice(5)), raw };
  if (raw.startsWith("open:")) {
    const u = new URL(raw.slice(5), "http://so.local");
    const sp = u.searchParams;
    if (sp.get("q")) {
      const p: EntryParams = {};
      for (const k of ["q", "promised", "pos", "k", "price"] as const) { const v = sp.get(k); if (v != null) p[k] = v; }
      return { kind: "open-q", params: p, raw };
    }
    return { kind: "open-m", text: sp.get("m") ?? "", raw };
  }
  throw new Error(`неизвестное действие диалога: «${raw}»`);
}

/** Текст первой реплики пользователя в теле запроса k (последнее сообщение user) */
export const lastUserText = (req: WireRequest): string => {
  const m = [...(req.body.messages ?? [])].reverse().find((x) => x.role === "user");
  return (m?.parts ?? []).filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join(" ");
};

/** Тестовый пользователь: chat_id = user_id (личный чат), username и имя — чтобы ловить их утечку */
export interface TestUser { chatId: number; userId: number; username: string; first_name: string; last_name: string }
export const testUser = (i: number): TestUser => ({
  chatId: 918_273_600 + i, userId: 918_273_600 + i, username: `so_audit_u${i}q`, first_name: "Аудитимя", last_name: `Аудитфамилия${i}`,
});

let updateSeq = 7_000_000;
export const nextUpdateId = () => ++updateSeq;

const fromOf = (u: TestUser) => ({ id: u.userId, is_bot: false, first_name: u.first_name, last_name: u.last_name, username: u.username, language_code: "ru" });
const chatOf = (u: TestUser, type = "private") =>
  (type === "private" ? { id: u.chatId, type, first_name: u.first_name, last_name: u.last_name, username: u.username } : { id: -u.chatId, type, title: "Аудит-группа" });

let messageSeq = 100;
export function messageUpdate(u: TestUser, text: string | null, o: { type?: string; extra?: Record<string, unknown>; updateId?: number } = {}): TgUpdate {
  const chat = chatOf(u, o.type);
  const message: Record<string, unknown> = { message_id: ++messageSeq, date: 1_760_000_000, chat, from: fromOf(u), ...(text != null ? { text } : {}), ...(o.extra ?? {}) };
  if (text != null && text.startsWith("/")) {
    const len = text.split(" ")[0].length;
    message.entities = [{ type: "bot_command", offset: 0, length: len }];
  }
  return { update_id: o.updateId ?? nextUpdateId(), message: message as TgUpdate["message"] & object };
}

export function callbackUpdate(u: TestUser, data: string, messageId: number): TgUpdate {
  return {
    update_id: nextUpdateId(),
    callback_query: { id: `cb${nextUpdateId()}`, from: fromOf(u), data, message: { message_id: messageId, chat: chatOf(u) } } as TgUpdate["callback_query"],
  };
}

/** Кнопки клавиатуры с callback_data, по порядку (строки сверху вниз, кнопки слева направо) */
export const callbackButtons = (kb: { inline_keyboard: { text: string; callback_data?: string }[][] }) =>
  kb.inline_keyboard.flat().filter((b) => typeof b.callback_data === "string");
