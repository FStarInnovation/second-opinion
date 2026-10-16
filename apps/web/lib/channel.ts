/**
 * Канал запроса /api/chat — сайт или Telegram-бот (план WP-TG §4.3). Канал читают только проверка ключа здесь, тексты отказа
 * и журнал маршрута; в решения (гейт, промпт, инструменты, модель) он не попадает (И2, TG.G3).
 *
 * Канал «telegram» — только при всех трёх условиях:
 *   1) id сессии начинается с TG_SESSION_PREFIX («tg_»);
 *   2) заголовок x-so-channel: telegram;
 *   3) заголовок x-so-bot-key совпал с SO_BOT_KEY.
 * Одно или два условия из трёх → 403 (ход не засчитывается); ни одного → «web».
 * SO_BOT_KEY читается при каждом вызове. Пустой или незаданный ключ на сервере — условие 3 не выполнено без сравнения
 * (иначе пустой заголовок прошёл бы на сервере без ключа): все tg-запросы получают 403 — это выключатель бота (§7).
 * Ключи сравниваются за постоянное время: timingSafeEqual над SHA-256 обеих строк (длины дайджестов равны всегда).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { HDR, TG_SESSION_PREFIX, type Channel } from "@so/present/protocol";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Заголовок x-so-bot-key совпал с непустым SO_BOT_KEY сервера */
function botKeyMatches(req: Request): boolean {
  const key = process.env.SO_BOT_KEY ?? "";
  if (key === "") return false;
  const given = req.headers.get(HDR.botKey);
  if (given == null) return false;
  return timingSafeEqual(sha256(given), sha256(key));
}

export function channelOf(req: Request, sessionId: string): { ok: true; channel: Channel } | { ok: false; status: 403 } {
  const met = [
    typeof sessionId === "string" && sessionId.startsWith(TG_SESSION_PREFIX), // id приходит из тела — у чужого клиента не строка
    req.headers.get(HDR.channel) === "telegram",
    botKeyMatches(req),
  ].filter(Boolean).length;
  if (met === 3) return { ok: true, channel: "telegram" };
  if (met === 0) return { ok: true, channel: "web" };
  return { ok: false, status: 403 };
}
