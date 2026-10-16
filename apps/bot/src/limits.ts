/**
 * Доступ и дневной лимит бота (план WP-TG §8, §9). Это транспорт, не решения: сервер о них не знает.
 *  - allowlist хранит псевдонимы (коды доступа), а не chat_id: "" — никто, "*" — все, иначе список через запятую;
 *  - дневной лимит ходов на псевдоним, сутки по Москве (UTC+3, без перехода на летнее время), — закрывает обход лимита
 *    сессии через /new. perDay ≤ 0 — без лимита (как SO_DAILY_BUDGET_USD=0 у сервера).
 */

/** Разрешён ли псевдоним списком allow */
export function isAllowed(pseudo: string, allow: string): boolean {
  const items = String(allow ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length || !pseudo) return false;
  return items.includes("*") || items.includes(pseudo);
}

/** Сутки по МСК: YYYY-MM-DD времени t + 3 ч */
const mskDay = (t: number) => new Date(t + 3 * 3_600_000).toISOString().slice(0, 10);

/** Счётчик ходов на псевдоним за сутки МСК; при смене суток счётчики обнуляются */
export class DailyLimit {
  private day = "";
  private readonly counts = new Map<string, number>();

  constructor(private readonly perDay: number, private readonly now: () => number) {}

  /** Взять один ход: true — можно, false — лимит суток исчерпан (счётчик не растёт) */
  take(pseudo: string): boolean {
    if (!(this.perDay > 0)) return true;
    const d = mskDay(this.now());
    if (d !== this.day) { this.day = d; this.counts.clear(); }
    const n = this.counts.get(pseudo) ?? 0;
    if (n >= this.perDay) return false;
    this.counts.set(pseudo, n + 1);
    return true;
  }
}
