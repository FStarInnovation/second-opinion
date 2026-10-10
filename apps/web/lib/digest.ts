/**
 * Что видит модель из результата инструмента. Полный контракт bond_report@1 (4–5 тыс. токенов)
 * идёт только в рендер блока; модели — дайджест ~600 токенов. Все числа — уже отформатированные
 * строки движка, чтобы модель цитировала их, а не пересчитывала (П25).
 */
import type { BondReportT, BuildResultT } from "@so/engine/contract";

export function digestReport(r: BondReportT) {
  const fired = r.flags.filter((f) => f.fired).sort((a, b) => b.points - a.points);
  return {
    status: r.status.kind,
    status_reason: r.status.reason,
    security: { shortname: r.security.shortname, isin: r.security.isin, emitent: r.security.emitent_title },
    data_line: r.data_time.line,
    product: r.product.plain_text,
    yield_kind: r.yield.kind,
    yield_line: r.yield.kind === "not_calculated" ? r.yield.not_calculated_reason : r.yield.line,
    // гейт controlFailPp (WP-D): свой расчёт не сошёлся с биржевым — комиссии/налог и колл не рассчитаны, показана только биржевая
    control_failed: r.yield.control_failed,
    claim_line: r.claim.line,
    price_line: r.price.line,
    liquidity_line: r.liquidity.line,
    fees_line: r.panels.includes("fees") ? r.fees_tax.line : null,
    worst: r.worst.map((w) => `${w.title}: ${w.text}`),
    truth_score: `${r.truth_score.score} — ${r.truth_score.grade}`,
    red_flags: fired.map((f) => `${f.title} (−${f.points})`),
    // предупреждения движка целиком (контроль своего расчёта против биржевого, гейт) — модель должна их видеть, не пересчитывая
    warnings: r.diagnostics.warnings,
    inputs: r.inputs,
    panels: r.panels,
    note: "Все числа уже показаны пользователю блоками отчёта. В тексте ответа числа не повторяй, ссылайся на блоки словами.",
  };
}

export function digestResult(res: BuildResultT) {
  switch (res.kind) {
    case "report": return digestReport(res.report);
    case "pick": return {
      status: "pick",
      query: res.query,
      count: res.candidates.length,
      candidates: res.candidates.slice(0, 20).map((c) => `${c.shortname} · ${c.isin ?? c.secid}${c.is_traded ? "" : " · не торгуется"}`),
      note: "Список выпусков показан пользователю блоком выбора. Попроси выбрать выпуск или уточнить запрос; сам не выбирай.",
    };
    case "notfound": return {
      status: "notfound", query: res.query, isin_valid: res.isinValid,
      note: res.isinValid ? "ISIN корректный, но на Мосбирже бумага не торгуется: внебиржевой или погашенный выпуск." : "Бумага не найдена: предложи проверить ISIN или название.",
    };
    case "err": return { status: "err", message: res.msg };
  }
}
