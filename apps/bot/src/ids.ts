/**
 * Идентификаторы бота (план WP-TG §4.4, §8).
 *  - Псевдоним чата — HMAC-SHA256(соль, chat_id), 12 символов base64url: код доступа для allowlist и ключ дневного лимита.
 *    Остаётся в боте; на сервер не уходит.
 *  - id сессии на сервере — `tg_` + 12 случайных символов (base64url от 9 случайных байт), без псевдонима: по коду доступа
 *    нельзя связать записи usage.jsonl одного человека из разных сессий.
 */
import { createHmac } from "node:crypto";
import { TG_SESSION_PREFIX } from "@so/present/protocol";

/** base64url(HMAC-SHA256(salt, String(chatId))).slice(0, 12) */
export function pseudonymOf(chatId: number, salt: string): string {
  return createHmac("sha256", salt).update(String(chatId)).digest("base64url").slice(0, 12);
}

/** `tg_${base64url(random(9))}` — 12 символов [A-Za-z0-9_-] после префикса */
export function newSessionId(random: (n: number) => Uint8Array): string {
  return TG_SESSION_PREFIX + Buffer.from(random(9)).toString("base64url");
}
