import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

/** Только главная: /check и /chat — инструменты, их текст строится по запросу пользователя (в sitemap не нужны) */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE}/`, changeFrequency: "weekly", priority: 1 }];
}
