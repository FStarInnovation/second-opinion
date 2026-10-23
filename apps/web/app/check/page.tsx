/**
 * Прямой путь постановки: /check?q=…&promised=…&pos=…&k=… → build() на сервере → те же блоки, что в чате.
 * Ноль токенов. Ввод суммы / комиссии / «обещали» пересчитывается в браузере функцией движка;
 * цена предложения (ветка «нет цены») — пересборкой через /api/report.
 * Под отчётом — «Обсудить с ассистентом» (/chat?q=…), только при включённом чате (фичефлаг SO_CHAT).
 */
import type { Metadata } from "next";
import { buildCached } from "@/lib/engine";
import { CheckClient } from "./CheckClient";

type Search = Record<string, string | string[] | undefined>;
const num = (v: string | string[] | undefined) => {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return undefined;
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }): Promise<Metadata> {
  const sp = await searchParams;
  // canonical без параметров: отчёт по ?q=… — инструмент, а не отдельная страница для поиска
  return { title: `${str(sp.q) || "Проверка"} · Second opinion`, alternates: { canonical: "/check" } };
}

export default async function CheckPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = str(sp.q).trim();
  const result = q
    ? await buildCached(q, {
        promised_pct: num(sp.promised) ?? null,
        position_size: num(sp.pos),
        k_pct: num(sp.k) ?? null,
        offer_price_pct: num(sp.price) ?? null,
      })
    : { kind: "err" as const, query: "", msg: "Укажите ISIN, название выпуска или ссылку на бумагу." };
  return <CheckClient query={q} result={result} chatEnabled={process.env.SO_CHAT !== "0"} />;
}
