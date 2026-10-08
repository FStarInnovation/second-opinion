/**
 * Сборка контракта bond_report@1 из фактов и метрик + композиция panels.
 * Инварианты плана: один контракт, числа только из движка, panels решают состав.
 */
import { BondReport, type BondReportT, type PanelIdT } from "./contract.js";
import type { BondFacts } from "./iss/facts.js";
import { dmy } from "./iss/facts.js";
import {
  CONFIG, afterTax, flags, fmt, fmtMax, horizon, liquidity, pctS, rub, curWord,
  plainText, worst, yieldModel, yieldOf,
} from "./metrics.js";

export interface BuildInputs {
  position_size?: number;
  k_pct?: number | null;
  promised_pct?: number | null;
  promised_text?: string | null;
  promised_source?: "field" | "file" | null;
  offer_price_pct?: number | null; // ветка «нет цены»
}

export function assembleReport(
  b: BondFacts,
  inputs: BuildInputs = {},
  diagnostics: { snapshot_dir?: string | null } = {},
): BondReportT {
  const pos = inputs.position_size ?? CONFIG.positionDefault;
  const k = inputs.k_pct ?? null;
  const promised = inputs.promised_pct ?? null;
  const userPrice = inputs.offer_price_pct ?? null;
  const warnings: string[] = [];

  const ym = yieldModel(b, { k, userPrice });
  const liq = liquidity(b, pos);
  const F = flags(b, ym, liq, promised);
  const W = worst(b, ym, F, pos);
  const h = ym.h ?? horizon(b);

  /* статус */
  let statusKind: BondReportT["status"]["kind"] = "ok";
  let statusReason: string | null = null;
  if (b.stop) { statusKind = "not_traded"; statusReason = "Бумага не торгуется на Мосбирже — внебиржевой или погашенный выпуск."; }
  else if (ym.status === "noRate") { statusKind = "no_coupon_rate"; statusReason = "ставка первого купона ещё не опубликована"; }
  else if (ym.status === "noPrice") { statusKind = "no_price"; statusReason = "нет цены"; }

  /* доходность */
  let yKind: BondReportT["yield"]["kind"] = "single";
  const values: { label: string; pct: number }[] = [];
  let periodIncome: BondReportT["yield"]["period_income"] = null;
  let yLine: string | null = null;
  let notCalc: string | null = null;

  if (statusKind === "no_coupon_rate") {
    yKind = "not_calculated";
    notCalc = "Не рассчитана: ставка первого купона ещё не опубликована";
    yLine = notCalc;
  } else if (statusKind === "no_price") {
    yKind = "not_calculated";
    notCalc = "Не рассчитана: нет цены";
    yLine = notCalc;
  } else if (statusKind === "not_traded") {
    yKind = "not_calculated";
    notCalc = "Не рассчитана: биржевых торгов нет";
    yLine = notCalc;
  } else if (ym.call?.short) {
    // Колл ≤ 30 дней: вместо годовой доходности — доход за период (2.3.3.1),
    // и для флоатера тоже (пример постановки — ЧеркизБ2P2)
    yKind = "period_income";
    periodIncome = {
      days: ym.call.days, gain_money: round2(ym.call.gain), gain_pct: round2(ym.call.gainPct),
      date: dmy(ym.call.dateIso)!,
    };
    if (ym.main != null) values.push({ label: "к погашению " + (dmy(b.matIso) ?? ""), pct: round2(ym.main) });
    yLine = `До колла ${dmy(ym.call.dateIso)} — ${daysW(ym.call.days)}: доход за период ${fmt(ym.call.gain, 2)} ₽ на облигацию (${fmt(ym.call.gainPct, 2)}%). Годовая ставка на коротком сроке неустойчива; к погашению — ${pctS(ym.main)}.`;
  } else if (b.ctype === "float" && ym.scen) {
    yKind = "scenarios";
    const labels = ["ставки не меняются", "снижение ставок", "высокие ставки дольше"];
    ym.scen.forEach((v, i) => { if (v != null) values.push({ label: labels[i], pct: round2(v) }); });
    yLine = `Если ставки не изменятся — ${pctS(ym.scen[0])}, при снижении — ${pctS(ym.scen[1])}, если высокие дольше — ${pctS(ym.scen[2])}. Купон сейчас ≈ ${fmt(b.r0 ?? 0, 1)}% годовых.`;
  } else if (ym.main != null) {
    yKind = "single";
    values.push({ label: "к " + h.label.replace(/^(погашения|оферты)/, "$1"), pct: round2(ym.main) });
    yLine = `${fmt(ym.main, 2)}% годовых — при покупке по ${fmt(ym.cleanPct ?? 0, 2)}% от номинала (${fmt(ym.P ?? 0, 2)} ${b.fu === "SUR" || b.fu === "RUB" ? "₽" : b.fu} с НКД) и удержании до ${h.label}. Купон — ${b.ctype === "fixed" ? fmtMax(b.cp ?? 0, 2) + "%" : "—"}.`;
    if (b.fu !== "SUR" && b.fu !== "RUB") yLine += ` Доходность в ${curWord(b.fu)}.`;
  }

  const controlDiff =
    ym.own != null && b.moexY != null ? round2(Math.abs(ym.own - b.moexY)) : null;
  if (controlDiff != null && controlDiff > CONFIG.controlWarnPp)
    warnings.push(`контроль: свой расчёт ${pctS(ym.own)} отличается от биржевого ${pctS(b.moexY)} на ${fmt(controlDiff, 2)} п.п.`);

  /* строка цены */
  const prevUsed = userPrice == null && b.wap == null && b.prevWap != null;
  let priceLine: string | null = null;
  if (ym.cleanPct != null && ym.P != null && ym.clean != null) {
    const cur = b.fu === "SUR" || b.fu === "RUB" ? "₽" : b.fu;
    priceLine =
      `Цена покупки ${fmt(ym.P, 2)} ${cur} = ${fmt(ym.clean, 2)} ${cur} (${fmt(ym.cleanPct, 2)}%) + НКД ${fmt(b.acc ?? 0, 2)} ${cur}` +
      (b.nextCouponIso ? `; НКД — не комиссия, вернётся с купоном ${dmy(b.nextCouponIso)}.` : ".") +
      (prevUsed ? " Цена — по вчерашней средневзвешенной." : "");
  }

  /* комиссии и налог: сетка для клиентской интерполяции */
  const kGrid: [number, number | null, number | null][] =
    statusKind === "ok" && ym.cleanPct != null
      ? CONFIG.kGrid.map((kk) => {
          const pre = yieldOf(b, ym.cleanPct!, kk, 1, h);
          const post = afterTax(b, ym.cleanPct!, kk, 1, h);
          return [kk, pre == null ? null : round2(pre), post == null ? null : round2(post)];
        })
      : [];
  const kk = k && k > 0 ? Math.min(k, 3) : 0;
  const pre = kGrid.length ? interp(kGrid, kk, 1) : null;
  const post = kGrid.length ? interp(kGrid, kk, 2) : null;
  const feeLine = kk
    ? `С комиссией брокера ${fmtMax(kk, 2)}% при покупке доходность — ${pctS(pre)} до налога и ${pctS(post)} после.`
    : `Укажите комиссию вашего брокера, чтобы учесть её в доходности. Без неё: ${pctS(pre)} до налога по графику выплат и ${pctS(post)} после налога 13%.`;

  /* заявленная доходность */
  const gap = F.gap;
  const claimLine =
    promised == null || ym.main == null
      ? null
      : `Обещали: ${fmtMax(promised, 2)}% · На самом деле: ${fmt(ym.main, 2)}% · Разница: ${fmt(Math.abs(gap ?? 0), 1)} п.п.`;

  /* композиция panels */
  const panels: PanelIdT[] = ["data_line", "product"];
  if (statusKind === "not_traded") {
    panels.push("flags_score", "plaque");
  } else {
    if (promised != null) panels.push("claim");
    if (statusKind === "no_price" && userPrice == null) panels.push("ask_price");
    else panels.push("yield", "price_line");
    panels.push("liquidity");
    if (statusKind === "ok") panels.push("fees");
    panels.push("worst", "flags_score", "plaque");
  }

  const report: BondReportT = {
    schema: "bond_report@1",
    product_type: "bond",
    built_at: new Date().toISOString(),
    data_time: { updatetime: b.upd, trade_date: b.tradeDateIso },
    security: {
      secid: b.secid, isin: b.isin, boardid: b.boardid, shortname: b.shortname,
      name: b.secname, regnumber: b.regnumber, emitent_title: b.emit, typename: b.kind,
    },
    status: { kind: statusKind, reason: statusReason },
    product: {
      plain_text: plainText(b),
      coupon_kind: b.ctype,
      coupon_label:
        b.ctype === "fixed" ? `фиксированный ${fmtMax(b.cp ?? 0, 2)}%`
        : b.ctype === "float" ? (b.r0 ? `плавающий, сейчас ≈ ${fmt(b.r0, 1)}%` : "плавающий")
        : b.ctype === "zero" ? "без купона" : "индексируемый номинал",
      amortization: b.amortized,
      offer: {
        type: b.offerKind,
        date: dmy(b.offerDateIso),
        price_pct: b.offerPrice,
        price_assumed_par: b.offerPriceAssumedPar,
        days_to: b.offerDateIso
          ? Math.round((Date.parse(b.offerDateIso) - Date.parse(b.todayIso)) / 86_400_000)
          : null,
      },
      faceunit: b.fu,
      currency_word: curWord(b.fu),
      listlevel: b.lvl,
      qualified: b.qual,
      maturity_date: dmy(b.matIso),
    },
    claim: {
      promised_pct: promised,
      promised_text: inputs.promised_text ?? null,
      source: promised == null ? null : inputs.promised_source ?? "field",
      gap_pp: gap == null ? null : round2(gap),
      line: claimLine,
    },
    yield: {
      kind: yKind,
      horizon: statusKind === "ok" ? h.kind : null,
      horizon_date: dmy(h.dateIso),
      horizon_label: h.label,
      values,
      main_pct: ym.main == null ? null : round2(ym.main),
      period_income: periodIncome,
      exchange: {
        pct: b.moexY == null ? null : round2(b.moexY),
        price_pct: b.moexYPrice,
        datetype: b.moexYDatetype,
        used_as_main: ym.useMoex,
      },
      own_control_pct: ym.own == null ? null : round2(ym.own),
      control_diff_pp: controlDiff,
      not_calculated_reason: notCalc,
      line: yLine,
    },
    price: {
      clean_pct: ym.cleanPct,
      prev_used: prevUsed,
      from_user: userPrice != null,
      facevalue: b.face,
      accruedint: b.acc,
      full_price: ym.P == null ? null : round2(ym.P),
      clean_price: ym.clean == null ? null : round2(ym.clean),
      next_coupon_date: dmy(b.nextCouponIso),
      currency: b.fu === "SUR" ? "RUB" : b.fu,
      line: priceLine,
    },
    liquidity: {
      traded: !b.stop,
      avg_turnover: liq.avg == null ? null : Math.round(liq.avg),
      days_counted: b.nDays,
      trades_per_day: b.avgNT == null ? null : round2(b.avgNT),
      spread_pct: liq.spread == null ? null : round2(liq.spread),
      spread_missing_side: liq.missing,
      position_size: pos,
      share_pct: liq.share == null ? null : round2(liq.share),
      exit_now_pct: liq.exitPct == null ? null : round2(liq.exitPct),
      exit_now_money: liq.exitCost == null ? null : Math.round(liq.exitCost),
      exit_days: liq.exitDays,
      category: liq.cat,
      no_exit: liq.noExit,
      line: liq.summary,
    },
    fees_tax: {
      k_pct: k,
      k_grid: kGrid,
      pre_tax_pct: pre == null ? null : round2(pre),
      post_tax_pct: post == null ? null : round2(post),
      tax_note: "по ставке 13%; льготы ИИС и долгосрочного владения не учтены",
      line: feeLine,
    },
    worst: statusKind === "ok" ? W.list : [],
    flags: F.all,
    truth_score: {
      score: F.score,
      grade: F.grade,
      top3: F.fired.slice(0, 3).map((f) => f.id),
      more_count: Math.max(0, F.fired.length - 3),
      none_fired: F.fired.length === 0,
    },
    macro: null,
    panels,
    inputs: {
      position_size: pos, k_pct: k, promised_pct: promised, offer_price_pct: userPrice,
    },
    diagnostics: {
      snapshot_dir: diagnostics.snapshot_dir ?? null,
      control_diff_pp: controlDiff,
      warnings,
    },
  };
  return BondReport.parse(report);
}

function round2(x: number): number { return Math.round(x * 100) / 100; }
function daysW(n: number): string {
  const w = n % 10 === 1 && n % 100 !== 11 ? "день"
    : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "дня" : "дней";
  return `${n} ${w}`;
}
function interp(grid: [number, number | null, number | null][], k: number, col: 1 | 2): number | null {
  if (!grid.length) return null;
  let i = 0;
  while (i < grid.length - 2 && k > grid[i + 1][0]) i++;
  const a = grid[i], b = grid[i + 1] ?? grid[i];
  const av = a[col], bv = b[col];
  if (av == null || bv == null) return av ?? bv;
  if (b[0] === a[0]) return av;
  const t = (k - a[0]) / (b[0] - a[0]);
  return av + (bv - av) * t;
}
