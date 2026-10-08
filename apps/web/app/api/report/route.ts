/**
 * Отчёт как JSON — для пересборки по цене предложения со страницы прямого пути
 * и для внешних потребителей контракта (кабинет, полный отчёт — после MVP).
 */
import { buildCached } from "@/lib/engine";
import type { ReportInputs } from "@so/engine/contract";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { query?: string; inputs?: ReportInputs };
  const query = (body.query ?? "").toString().trim().slice(0, 200);
  if (!query) return Response.json({ kind: "err", query, msg: "Укажите бумагу" }, { status: 400 });
  const res = await buildCached(query, body.inputs ?? {});
  return Response.json(res, { headers: { "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const query = (u.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (!query) return Response.json({ kind: "err", query, msg: "Укажите бумагу: ?q=ISIN" }, { status: 400 });
  const n = (k: string) => { const v = u.searchParams.get(k); return v == null || v === "" ? undefined : Number(v.replace(",", ".")); };
  const res = await buildCached(query, { promised_pct: n("promised") ?? null, position_size: n("pos"), k_pct: n("k") ?? null, offer_price_pct: n("price") ?? null });
  return Response.json(res, { headers: { "cache-control": "no-store" } });
}
