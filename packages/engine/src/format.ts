/**
 * Форматирование чисел и слов (ru-RU, как в постановке).
 * Модуль без зависимостей от Node — используется и движком, и страницей в браузере.
 */
export const fmt = (x: number, d: number) =>
  new Intl.NumberFormat("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }).format(x);
export const fmtMax = (x: number, d: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: d }).format(x);
export const pctS = (x: number | null) => (x == null ? "—" : fmt(x, 2) + "%");
export const rub = (x: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(x)) + " ₽";
export const mln = (x: number | null) => {
  if (x == null) return "—";
  if (x >= 1e9) return fmt(x / 1e9, 2) + " млрд ₽";
  if (x >= 1e6) return fmt(x / 1e6, 1) + " млн ₽";
  if (x >= 1e3) return fmt(x / 1e3, 0) + " тыс. ₽";
  return fmt(x, 0) + " ₽";
};
export const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(Math.trunc(n));
  return a % 10 === 1 && a % 100 !== 11 ? one
    : [2, 3, 4].includes(a % 10) && ![12, 13, 14].includes(a % 100) ? few
    : many;
};
export const daysWord = (n: number) => `${n} ${plural(n, "день", "дня", "дней")}`;
export const termPhrase = (days: number) => {
  const y = days / 365;
  if (y < 1) return Math.max(1, Math.round(days / 30.4)) + " мес.";
  const r = Math.round(y * 10) / 10;
  const s = fmtMax(r, 1);
  if (Number.isInteger(r)) return `${s} ${plural(r, "год", "года", "лет")}`;
  return s + " года";
};
export const curWord = (fu: string) =>
  fu === "SUR" || fu === "RUB" ? "рублях" : fu === "CNY" ? "юанях" : fu === "USD" ? "долларах" : fu === "EUR" ? "евро" : fu;
/** «2026-10-08» → «08.10.2026» */
export const dmyIso = (iso: string | null) => {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
};
export const round2 = (x: number) => Math.round(x * 100) / 100;
export const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
