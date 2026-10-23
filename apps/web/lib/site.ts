/**
 * Адрес и подписи сайта — одно место для metadataBase, canonical, Open Graph, sitemap, robots, llms.txt и JSON-LD.
 * Стенд может отвечать и на другом имени (sslip.io, IP) — ссылки для поисковиков всё равно ведут на основной домен.
 * SITE_URL читается при сборке (robots, sitemap, llms.txt и главная — статические), без «/» в конце.
 */
export const SITE = (process.env.SITE_URL || "https://mkt-second-opinion.ru").replace(/\/+$/, "");

/** Название и описание — прежние тексты layout.tsx */
export const SITE_NAME = "Second opinion · Атремус";
export const SITE_DESCRIPTION =
  "Проверь, что тебе продают: реальная доходность, ликвидность, риски и Product Truth Score облигации на данных Мосбиржи.";

/** Open Graph по умолчанию: layout.tsx берёт как есть, главная добавляет og:url (вложенный openGraph в Next заменяется целиком) */
export const OPEN_GRAPH = {
  type: "website",
  locale: "ru_RU",
  siteName: SITE_NAME,
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
} as const;
