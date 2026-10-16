/**
 * Сверка собственного имени бота (план WP-TG §4.4, §8). Единственное место в apps/bot, где читается username, — и это
 * username самого бота из getMe, а не собеседника (TG.1). Не тот бот (чужой токен в .env) → main.ts завершается с кодом 1.
 */

/** getMe вернул бота с именем handle (без «@», без учёта регистра) */
export function sameBot(me: { username?: string }, handle: string): boolean {
  const mine = String(me?.username ?? "").replace(/^@/, "").toLowerCase();
  const want = String(handle ?? "").trim().replace(/^@/, "").toLowerCase();
  return mine !== "" && mine === want;
}
