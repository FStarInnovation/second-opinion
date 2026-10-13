/**
 * Что видит модель из результата инструмента. Полный контракт bond_report@1 (4–5 тыс. токенов)
 * идёт только в рендер блока; модели — дайджест ~600 токенов. Все числа — уже отформатированные
 * строки движка, чтобы модель цитировала их, а не пересчитывала (П25).
 */
import type { BondReportT, BuildResultT } from "@so/engine/contract";
import { fmt } from "@so/engine/format";

/** Предупреждения движка о контроле своего расчёта (report.ts): «контроль: свой расчёт …» и «гейт контроля: …» */
const CONTROL_WARNING = /^(контроль|гейт контроля)\s*:/i;

/**
 * Предупреждения для модели. Без гейта — как у движка: свой расчёт сошёлся с биржевым в пределах controlFailPp и лежит
 * в основе блока комиссий, его число модели знать можно (остаточный риск: от его повторения модель удерживает правило 10
 * промпта; D.2 и H.6 требуют строку движка целиком). При сработавшем гейте (yield.control_failed) сырые строки несут
 * ненадёжный собственный расчёт и жаргон («гейт», «сетка комиссий», «…к коллу не рассчитаны» при главной доходности к коллу),
 * поэтому вместо них одна фраза: сигнал контроля и размер расхождения остаются, числа своего расчёта нет (разбор диалогов
 * 12.10, U.11). Чья доходность показана — по yieldSource, как в yield_source, чтобы ответы на «как посчитали?» не расходились;
 * следствие гейта — только то, что комиссия и налог не посчитаны (чья доходность главная, решает не гейт, а цена и вид бумаги).
 * При доходе за период (близкий колл) в блоке два числа разного происхождения — наш доход за период и доходность к погашению,
 * а фраза движка в yield_line говорит «показываем только биржевую доходность»: здесь фраза о том, чья доходность, не добавляется
 * (несогласованность фразы движка — вопрос к владельцу движка). Прочие предупреждения, если появятся, идут как есть.
 */
function modelWarnings(r: BondReportT): string[] {
  const w = r.diagnostics.warnings;
  if (!r.yield.control_failed) return w;
  const diff = r.yield.control_diff_pp ?? r.diagnostics.control_diff_pp;
  const src = r.yield.kind === "period_income" ? null : yieldSource(r);
  const shown = src == null ? "" : src === "Мосбиржа" ? "; показана биржевая доходность" : "; показана наша доходность, биржей не подтверждённая";
  return [
    `Наш контрольный расчёт по графику выплат не сошёлся с биржевым${diff != null ? ` (расхождение ${fmt(diff, 2)} п.п.)` : ""}, поэтому доходность с комиссией и налогом не показана${shown}.`,
    ...w.filter((s) => !CONTROL_WARNING.test(s)),
  ];
}

/**
 * Чья главная доходность в блоке — для вопроса «как посчитали?» (правило 10 промпта). Обычно биржевая. Наш расчёт по графику
 * выплат главный у флоатера (три сценария), при близком колле (доход за период), от цены пользователя, у валютного выпуска,
 * без биржевой доходности к показанной цене и когда наша доходность к коллу ниже биржевой (metrics.ts, правило (б)):
 * в последнем случае exchange.used_as_main остаётся true, но main_pct не равна exchange.pct.
 */
function yieldSource(r: BondReportT): string | null {
  const y = r.yield;
  if (y.kind === "not_calculated") return null;
  const exchange = y.kind === "single" && y.exchange.used_as_main && y.main_pct != null && y.main_pct === y.exchange.pct;
  return exchange ? "Мосбиржа" : "наш расчёт по графику выплат";
}

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
    // чья главная доходность: «Мосбиржа» или «наш расчёт по графику выплат» (правило 10 промпта)
    yield_source: yieldSource(r),
    // гейт controlFailPp (WP-D): свой расчёт не сошёлся с биржевым — комиссии/налог и колл не рассчитаны (чья доходность — yield_source)
    control_failed: r.yield.control_failed,
    claim_line: r.claim.line,
    price_line: r.price.line,
    liquidity_line: r.liquidity.line,
    fees_line: r.panels.includes("fees") ? r.fees_tax.line : null,
    worst: r.worst.map((w) => `${w.title}: ${w.text}`),
    truth_score: `${r.truth_score.score} — ${r.truth_score.grade}`,
    red_flags: fired.map((f) => `${f.title} (−${f.points})`),
    // предупреждения движка (контроль своего расчёта против биржевого) — модель видит их, не пересчитывая; при гейте — одной фразой
    warnings: modelWarnings(r),
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
