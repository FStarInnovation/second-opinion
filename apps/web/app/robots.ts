import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

/** Тестовый стенд не индексируем; SO_PUBLIC=1 — открыть для поисковиков при запуске (API закрыт, sitemap и host — основной домен) */
export default function robots(): MetadataRoute.Robots {
  const open = process.env.SO_PUBLIC === "1";
  if (!open) return { rules: { userAgent: "*", disallow: "/" } };
  return { rules: { userAgent: "*", allow: "/", disallow: "/api/" }, sitemap: `${SITE}/sitemap.xml`, host: SITE };
}
