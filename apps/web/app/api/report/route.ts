/**
 * Отчёт как JSON — для пересборки по цене предложения со страницы прямого пути
 * и для внешних потребителей контракта (кабинет, полный отчёт — после MVP).
 * Ввод проверяется той же схемой, что у чата и /check (ReportInputsSchema); ввод вне схемы — {kind:"err"} с HTTP 400,
 * а не отчёт по испорченным числам.
 */
import { buildCached } from "@/lib/engine";
import { ReportInputsSchema } from "@so/engine/contract";

/** Поля ввода по-русски — для текста ошибки */
const FIELD_RU: Record<string, string> = {
  position_size: "сумма вложения", k_pct: "комиссия брокера", promised_pct: "обещанная доходность", offer_price_pct: "цена предложения",
};
/** Ввод вне схемы: какие поля не прошли — в тексте, без чисел и технических подробностей.
 *  Нет известного поля (пустой path — inputs не объект) — своя фраза без повтора «ввод». */
function badInputs(query: string, issues: { path: (string | number)[] }[]) {
  const fields = [...new Set(issues.map((i) => FIELD_RU[String(i.path[0])]).filter((f): f is string => !!f))];
  const msg = fields.length
    ? `Проверьте ввод: ${fields.join(", ")} — вне допустимых значений.`
    : "Проверьте ввод: данные не распознаны.";
  return Response.json({ kind: "err", query, msg }, { status: 400, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { query?: string; inputs?: unknown };
  const query = (body.query ?? "").toString().trim().slice(0, 200);
  if (!query) return Response.json({ kind: "err", query, msg: "Укажите бумагу" }, { status: 400 });
  const inputs = ReportInputsSchema.safeParse(body.inputs ?? {});
  if (!inputs.success) return badInputs(query, inputs.error.issues);
  const res = await buildCached(query, inputs.data);
  return Response.json(res, { headers: { "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const query = (u.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (!query) return Response.json({ kind: "err", query, msg: "Укажите бумагу: ?q=ISIN" }, { status: 400 });
  const n = (k: string) => { const v = u.searchParams.get(k); return v == null || v === "" ? undefined : Number(v.replace(",", ".")); };
  const inputs = ReportInputsSchema.safeParse({ promised_pct: n("promised"), position_size: n("pos"), k_pct: n("k"), offer_price_pct: n("price") });
  if (!inputs.success) return badInputs(query, inputs.error.issues);
  const i = inputs.data;
  const res = await buildCached(query, { promised_pct: i.promised_pct ?? null, position_size: i.position_size, k_pct: i.k_pct ?? null, offer_price_pct: i.offer_price_pct ?? null });
  return Response.json(res, { headers: { "cache-control": "no-store" } });
}
