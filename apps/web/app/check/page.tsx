/**
 * Прямой путь постановки: /check?q=…&promised=…&pos=…&k=… → build() на сервере → те же блоки, что в чате.
 * Параметры проверяются схемой ReportInputsSchema поле за полем: невалидное игнорируется.
 * Ноль токенов. Ввод суммы / комиссии / «обещали» пересчитывается в браузере функцией движка;
 * цена предложения (ветка «нет цены») — пересборкой через /api/report.
 * Под отчётом — «Обсудить с ассистентом» (/chat?q=…), только при включённом чате (фичефлаг SO_CHAT).
 */
import type { Metadata } from "next";
import { ReportInputsSchema } from "@so/engine/contract";
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
/** Поле ввода из параметра — недоверенный ввод: поле за полем через ReportInputsSchema (та же схема, что у чата и /api/report);
 *  невалидное игнорируется (поле по умолчанию), а не ошибка — как initialOf у /chat?q=… */
const field = (k: keyof typeof ReportInputsSchema.shape, v: string | string[] | undefined) => {
  const n = num(v);
  return n !== undefined && ReportInputsSchema.shape[k].safeParse(n).success ? n : undefined;
};

export async function generateMetadata({ searchParams }: { searchParams: Promise<Search> }): Promise<Metadata> {
  const sp = await searchParams;
  return { title: `${str(sp.q) || "Проверка"} · Second opinion` };
}

export default async function CheckPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const q = str(sp.q).trim();
  const result = q
    ? await buildCached(q, {
        promised_pct: field("promised_pct", sp.promised) ?? null,
        position_size: field("position_size", sp.pos),
        k_pct: field("k_pct", sp.k) ?? null,
        offer_price_pct: field("offer_price_pct", sp.price) ?? null,
      })
    : { kind: "err" as const, query: "", msg: "Укажите ISIN, название выпуска или ссылку на бумагу." };
  return <CheckClient query={q} result={result} chatEnabled={process.env.SO_CHAT !== "0"} />;
}
