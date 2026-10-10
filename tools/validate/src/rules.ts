/**
 * Правила валидатора по контракту — НЕЗАВИСИМАЯ запись спецификации из dev-дока
 * («Реестр блоков», «Правила композиции», «Валидатор и golden-набор»), а не вызов композитора движка:
 * так проверка не превращается в тавтологию.
 */
import type { BondReportT, PanelIdT } from "@so/engine/contract";
import { CONFIG } from "@so/engine/config";

export interface Finding { rule: string; msg: string; level: "fail" | "warn" }

const nonEmpty = (x: unknown) => x != null && !(typeof x === "string" && x.trim() === "");

/** Условия применимости блоков (таблица «Реестр блоков») + обязательные поля. */
const REGISTRY: Record<PanelIdT, { when: (r: BondReportT) => boolean; required: (r: BondReportT) => [string, unknown][] }> = {
  data_line: { when: () => true, required: (r) => [["data_time.line", r.data_time.line]] },
  product: { when: () => true, required: (r) => [["product.plain_text", r.product.plain_text]] },
  claim: { when: (r) => r.claim.promised_pct != null, required: (r) => [["claim.line", r.claim.line], ["claim.gap_pp", r.claim.gap_pp]] },
  yield: {
    // status = ok; вариация not_calculated — у флоатера без выплаченных купонов (no_coupon_rate)
    when: (r) => r.status.kind === "ok" || r.status.kind === "no_coupon_rate" || r.status.kind === "structured" || r.status.kind === "perpetual",
    required: (r) =>
      r.yield.kind === "not_calculated"
        ? [["yield.not_calculated_reason", r.yield.not_calculated_reason]]
        : r.yield.kind === "period_income"
          ? [["yield.line", r.yield.line], ["yield.period_income", r.yield.period_income]]
          : [["yield.line", r.yield.line], ["yield.values[0]", r.yield.values[0]], ["yield.main_pct", r.yield.main_pct]],
  },
  price_line: { when: (r) => r.price.full_price != null, required: (r) => [["price.line", r.price.line]] },
  ask_price: { when: (r) => r.status.kind === "no_price", required: () => [] },
  liquidity: { when: (r) => r.liquidity.traded, required: (r) => [["liquidity.line", r.liquidity.line]] },
  fees: {
    // при гейте расхождения (yield.control_failed) сетки комиссий нет — панель не применима
    when: (r) => r.status.kind === "ok" && !r.yield.control_failed,
    required: (r) => [["fees_tax.line", r.fees_tax.line], ["fees_tax.post_tax_pct", r.fees_tax.post_tax_pct], ["fees_tax.k_grid(5)", r.fees_tax.k_grid.length === 5 ? 1 : null]],
  },
  worst: { when: (r) => r.status.kind === "ok", required: (r) => [["worst(1–6)", r.worst.length >= 1 && r.worst.length <= 6 ? 1 : null]] },
  flags_score: { when: () => true, required: (r) => [["truth_score.grade", r.truth_score.grade]] },
  macro: { when: (r) => r.macro != null, required: () => [] },
  plaque: { when: () => true, required: () => [] },
};

/** Ветки композиции: что ОБЯЗАНО быть и чего НЕ должно быть при данном статусе. */
function mustHave(r: BondReportT): { must: PanelIdT[]; mustNot: PanelIdT[] } {
  const always: PanelIdT[] = ["data_line", "product", "flags_score", "plaque"];
  switch (r.status.kind) {
    // fees обязателен, пока гейт расхождения молчит; при yield.control_failed комиссии не рассчитаны — панель показывать нельзя
    case "ok": return r.yield.control_failed
      ? { must: [...always, "yield", "liquidity", "worst"], mustNot: ["ask_price", "fees"] }
      : { must: [...always, "yield", "liquidity", "fees", "worst"], mustNot: ["ask_price"] };
    case "no_price": return { must: [...always, "ask_price"], mustNot: ["yield", "fees", "worst"] };
    case "not_traded": return { must: always, mustNot: ["yield", "liquidity", "fees", "ask_price", "claim"] };
    case "no_coupon_rate": return { must: [...always, "yield"], mustNot: ["fees", "ask_price"] };
    // Структурная / бессрочная: доходность «не рассчитана» с объяснением, комиссий и worst-case нет
    case "structured":
    case "perpetual": return { must: [...always, "yield"], mustNot: ["fees", "worst", "ask_price", "claim"] };
  }
}

const GRADES: [number, string][] = [[85, "Прозрачный продукт"], [70, "Есть оговорки"], [50, "Много рисков"], [0, "Высокий риск"]];

export function checkContract(r: BondReportT): Finding[] {
  const out: Finding[] = [];
  const fail = (rule: string, msg: string) => out.push({ rule, msg, level: "fail" });

  // panels: условие каждого блока и обязательные поля
  const seen = new Set<string>();
  for (const id of r.panels) {
    if (seen.has(id)) fail("panels", `блок ${id} дважды`);
    seen.add(id);
    const spec = REGISTRY[id];
    if (!spec.when(r)) fail("panels", `в panels блок «${id}», а его условие применимости не выполнено (status=${r.status.kind})`);
    for (const [name, v] of spec.required(r)) if (!nonEmpty(v)) fail("required", `блок «${id}»: пусто обязательное поле ${name}`);
  }
  const { must, mustNot } = mustHave(r);
  for (const id of must) if (!seen.has(id)) fail("panels", `status=${r.status.kind}: нет обязательного блока «${id}»`);
  for (const id of mustNot) if (seen.has(id)) fail("panels", `status=${r.status.kind}: блок «${id}» показывать нельзя`);
  if (r.claim.promised_pct != null && r.claim.line != null && !seen.has("claim")) fail("panels", "введено «обещали», а блока claim нет");

  // контроль своего расчёта против биржевого: пороги — из CONFIG движка (одна величина — одно значение).
  // > controlWarnPp — предупреждение; > controlFailPp без пометки гейта — падение (ошибка данных страницы);
  // с пометкой yield.control_failed гейт сработал корректно — тогда проверяется, что производное от own погашено.
  const d = r.yield.control_diff_pp;
  const gated = r.yield.control_failed;
  if (d != null && d > CONFIG.controlFailPp && !gated) fail("control", `расхождение своего расчёта с биржевым ${d} п.п. > ${CONFIG.controlFailPp}, а гейт не сработал — похоже на ошибку данных`);
  else if (d != null && d > CONFIG.controlWarnPp) out.push({ rule: "control", msg: `расхождение с биржевым ${d} п.п. > ${CONFIG.controlWarnPp}`, level: "warn" });
  if (gated) {
    if (d == null || d <= CONFIG.controlFailPp) fail("control", `гейт сработал (control_failed), а расхождение ${d} п.п. не больше порога ${CONFIG.controlFailPp}`);
    if (seen.has("fees")) fail("control", "гейт сработал, а блок fees в panels");
    if (r.fees_tax.k_grid.length !== 0) fail("control", `гейт сработал, а k_grid не пуст (${r.fees_tax.k_grid.length} строк)`);
    if (r.fees_tax.pre_tax_pct != null || r.fees_tax.post_tax_pct != null) fail("control", "гейт сработал, а fees_tax.pre/post_tax_pct заданы");
    // элемент call с датой колла (доходность к коллу / доход за период) производен от своего расчёта; без даты он own-числа не несёт и остаётся
    if (r.worst.some((w) => w.id === "call" && (r.product.offer.date != null || /\d/.test(w.text))))
      fail("control", "гейт сработал, а в worst остался сценарий «call» с own-числом (доходность к коллу / доход за период)");
    if (!/не сошёлся/.test(r.yield.line ?? "")) fail("control", "гейт сработал, а в yield.line нет фразы «не сошёлся»");
  }

  // Truth Score: баллы, топ-3 и градация согласованы
  const fired = r.flags.filter((f) => f.fired);
  for (const f of r.flags) if (!f.fired && f.points !== 0) fail("score", `флаг ${f.id} не сработал, но points=${f.points}`);
  const sum = fired.reduce((s, f) => s + f.points, 0);
  const score = Math.max(0, 100 - sum);
  if (r.truth_score.score !== score) fail("score", `truth_score=${r.truth_score.score}, а 100 − Σ баллов = ${score}`);
  const grade = GRADES.find(([m]) => score >= m)![1];
  if (r.truth_score.grade !== grade) fail("score", `градация «${r.truth_score.grade}» не соответствует ${score} («${grade}»)`);
  const pts = fired.map((f) => f.points).sort((a, b) => b - a);
  const topPts = r.truth_score.top3.map((id) => r.flags.find((f) => f.id === id)?.points ?? -1);
  if (r.truth_score.top3.length !== Math.min(3, fired.length)) fail("score", `top3 длиной ${r.truth_score.top3.length}, сработало ${fired.length}`);
  topPts.forEach((p, i) => { if (p !== pts[i]) fail("score", `top3[${i}] = ${p} баллов, ожидалось ${pts[i]}`); });
  for (const id of r.truth_score.top3) if (!fired.some((f) => f.id === id)) fail("score", `в top3 несработавший флаг ${id}`);
  if (r.truth_score.more_count !== Math.max(0, fired.length - 3)) fail("score", `more_count=${r.truth_score.more_count}`);
  if (r.truth_score.none_fired !== (fired.length === 0)) fail("score", "none_fired не согласован");
  return out;
}

/** Факты, которые не имеют права появиться в шаблоне (client.js, css, оболочка HTML). */
export function factTokens(results: unknown[]): string[] {
  const t = new Set<string>();
  const add = (s: unknown) => { if (typeof s === "string" && s.trim().length >= 4) t.add(s.trim()); };
  const pct = (x: unknown) => { if (typeof x === "number") t.add(new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x) + "%"); };
  for (const res of results as any[]) {
    if (res.kind === "report") {
      // данные могут быть битыми (их ловит правило schema) — здесь только собираем то, что есть
      const r = res.report as Partial<BondReportT> & Record<string, any>;
      [r.security?.secid, r.security?.isin, r.security?.shortname, r.security?.regnumber, r.security?.name,
        r.product?.maturity_date, r.product?.offer?.date, r.yield?.horizon_date, r.price?.next_coupon_date].forEach(add);
      (r.yield?.values ?? []).forEach((v: { pct: number }) => pct(v.pct));
    } else if (res.kind === "pick") {
      for (const c of res.candidates) [c.secid, c.isin, c.shortname, c.regnumber].forEach(add);
    } else if (res.kind === "notfound") add(res.query);
  }
  return [...t];
}
