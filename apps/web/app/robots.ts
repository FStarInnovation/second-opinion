import type { MetadataRoute } from "next";

/** Тестовый стенд не индексируем; SO_PUBLIC=1 — открыть для поисковиков при запуске */
export default function robots(): MetadataRoute.Robots {
  const open = process.env.SO_PUBLIC === "1";
  return { rules: open ? { userAgent: "*", allow: "/" } : { userAgent: "*", disallow: "/" } };
}
