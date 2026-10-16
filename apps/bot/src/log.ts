/**
 * Журнал бота (план WP-TG §4.4, §7, §8): только записи LogRec — событие и несколько служебных полей. Текстов реплик, chat_id,
 * user_id, имён и токена в журнале нет; псевдоним (pseudo) пишется только в событиях отказа (notAllowed, dailyLimit).
 *
 * Формат строки: `${ev}`, затем ` ${k}=${v}` по полям в фиксированном порядке (pseudo, upd, ms, status, err, version).
 * {ev:"getMe ok", version:"abc1234"} → «getMe ok version=abc1234» — эту строку ищет deploy.sh после старта бота.
 * Секреты (токен, SO_BOT_KEY, соль; у токена — и часть после «:») и любые «bot<цифры>:…» вырезаются в <redacted>.
 */

export type LogRec = {
  ev: string; pseudo?: string; upd?: "message" | "callback" | "command" | "other"; ms?: number;
  status?: string; err?: string; version?: string;
};

/** Поля после ev — в этом порядке */
const ORDER = ["pseudo", "upd", "ms", "status", "err", "version"] as const;
const REDACTED = "<redacted>";
/** Длина значения поля в строке журнала */
const MAX_VALUE = 300;

/** Секреты для вырезания: сами значения и хвост токена Bot API («<цифры>:<секрет>» → и «<секрет>»); длинные первыми */
function secretList(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of secrets) {
    if (typeof s !== "string" || s.length < 4) continue;
    out.add(s);
    const tail = /^\d+:(.+)$/.exec(s)?.[1];
    if (tail && tail.length >= 8) out.add(tail);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Логгер: запись → одна строка в sink. Значения в одну строку (переводы строк → пробел), не длиннее MAX_VALUE.
 * @param sink    куда писать строку (main.ts — stdout, его читает journalctl)
 * @param secrets токен, SO_BOT_KEY, соль — вырезаются из любой части строки
 */
export function makeLogger(sink: (line: string) => void, secrets: string[]): (r: LogRec) => void {
  const list = secretList(secrets);
  const clean = (v: string): string => {
    let t = v.replace(/\s+/g, " ").trim();
    for (const s of list) t = t.split(s).join(REDACTED);
    t = t.replace(/bot\d+:[A-Za-z0-9_-]+/g, `bot${REDACTED}`).replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}/g, REDACTED);
    return t.length > MAX_VALUE ? t.slice(0, MAX_VALUE - 1) + "…" : t;
  };
  return (r: LogRec) => {
    let line = clean(String(r?.ev ?? "")) || "?";
    for (const k of ORDER) {
      const v = r?.[k];
      if (v === undefined || v === null || v === "") continue;
      line += ` ${k}=${clean(String(v))}`;
    }
    try { sink(line); } catch { /* журнал не роняет бота */ }
  };
}
