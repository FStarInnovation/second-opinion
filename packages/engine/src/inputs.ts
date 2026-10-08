/**
 * Ввод пользователя → зависимые поля контракта (позиция, комиссия брокера, «обещали»).
 *
 * Это функция движка, а не UI: её вызывает и сборка отчёта на сервере (assembleReport),
 * и страница в браузере при смене ввода — формулы и тексты живут в одном месте
 * (инварианты 1 и 3 плана). Работает только по полям контракта, в ISS не ходит,
 * YTM не решает: доходность с комиссией — интерполяция по k_grid, посчитанной движком.
 * Цена предложения (ветка «нет цены») требует полной пересборки — см. needsRebuild().
 *
 * Модуль без зависимостей от Node и zod — попадает в клиентский бандл страницы.
 */
import type { BondReportT, PanelIdT, ReportInputs } from "./contract";
import { CONFIG, gradeOf } from "./config";
import { daysWord, fmt, fmtMax, pctS, round2, rub } from "./format";

type R = BondReportT;

/* ───── тексты, зависящие от ввода (единственный источник) ───── */

export function liquidityLine(r: R, pos: number): {
  share_pct: number | null; exit_now_money: number | null; exit_days: number | null; line: string;
} {
  const L = r.liquidity;
  const avg = L.avg_turnover;
  const exitPct = L.exit_now_pct;
  const share = avg && avg > 0 ? round2((pos / avg) * 100) : null;
  const exitDays = avg && avg > 0 ? Math.max(1, Math.ceil(pos / (avg * CONFIG.liq.dayShare))) : null;
  const exitMoney = exitPct == null ? null : Math.round((pos * exitPct) / 100);
  let line: string;
  if (!L.traded) line = "Биржевых торгов по бумаге нет — выйти через биржу нельзя.";
  else if (!avg)
    line = L.days_counted
      ? `За последние ${L.days_counted} торговых дней по бумаге не было сделок — выйти через биржу сейчас нельзя. Категория ликвидности — низкая.`
      : `За последние ${CONFIG.liq.windowDays} дней по бумаге не было ни одной сделки — выйти через биржу сейчас нельзя. Категория ликвидности — низкая.`;
  else
    line =
      `При позиции ${rub(pos)} стоимость моментального выхода ≈ ` +
      (exitPct == null ? "не определить: в стакане нет встречных заявок" : fmt(exitPct, 2) + "%") +
      `, аккуратного выхода ≈ ${daysWord(exitDays!)}. Категория ликвидности — ${L.category}.`;
  return { share_pct: share, exit_now_money: exitMoney, exit_days: exitDays, line };
}

export const worstRatesText = (d1: number, d3: number, pos: number, horizonLabel: string) =>
  `При росте ставок на 1 п.п. цена упадёт примерно на ${fmt(d1, 1)}%, на 3 п.п. — на ${fmt(d3, 1)}% (−${rub((pos * d3) / 100)} на вашу позицию). Если держать до ${horizonLabel}, убытка не будет.`;
export const worstDefaultText = (pos: number, premium: boolean) =>
  `В худшем случае можно потерять вложенное — до ${rub(pos)}.` +
  (premium ? " Рынок оценивает кредитный риск эмитента как высокий." : "");
export const worstFxText = (pos: number) =>
  `При укреплении рубля к валюте номинала на 10% рублёвый результат снизится примерно на 10% (−${rub(pos * CONFIG.fxShock)}).`;

/** Флаг 12 «Обещанная доходность выше реальной» (2.3.3.5) — единственная реализация правила. */
export function flag12(promised: number | null, main: number | null) {
  const C = CONFIG.flags;
  const gap = promised != null && main != null ? promised - main : null;
  const fired = gap != null && gap > C.gapPp;
  return {
    gap,
    fired,
    points: fired ? (gap! > C.gapHighPp ? C.gapHighPts : C.gapPts) : 0,
    details: gap == null ? "заявленная не указана" : `обещали ${fmtMax(promised!, 2)}%, расчётная ${pctS(main)}`,
  };
}

export function interpGrid(grid: [number, number | null, number | null][], k: number, col: 1 | 2): number | null {
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

export function feesLine(grid: [number, number | null, number | null][], k: number | null) {
  const kk = k && k > 0 ? Math.min(k, CONFIG.kMax) : 0;
  const pre = grid.length ? interpGrid(grid, kk, 1) : null;
  const post = grid.length ? interpGrid(grid, kk, 2) : null;
  const line = kk
    ? `С комиссией брокера ${fmtMax(kk, 2)}% при покупке доходность — ${pctS(pre)} до налога и ${pctS(post)} после.`
    : `Укажите комиссию вашего брокера, чтобы учесть её в доходности. Без неё: ${pctS(pre)} до налога по графику выплат и ${pctS(post)} после налога 13%.`;
  return { pre: pre == null ? null : round2(pre), post: post == null ? null : round2(post), line };
}

/* ───── композиция panels (правила раздела «Правила композиции» dev-дока) ───── */
export function composePanels(r: R): PanelIdT[] {
  const s = r.status.kind;
  const p: PanelIdT[] = ["data_line", "product"];
  if (s === "not_traded") {
    p.push("flags_score");
  } else {
    if (r.claim.line != null) p.push("claim");
    if (s === "no_price") p.push("ask_price");
    else {
      p.push("yield");
      if (r.price.line != null) p.push("price_line");
    }
    p.push("liquidity");
    if (s === "ok") p.push("fees", "worst");
    p.push("flags_score");
  }
  if (r.macro != null) p.push("macro");
  p.push("plaque");
  return p;
}

/* ───── главный вход ───── */
export function applyInputs(base: R, inputs: ReportInputs): R {
  const pos = inputs.position_size ?? base.inputs.position_size ?? CONFIG.positionDefault;
  const k = inputs.k_pct === undefined ? base.inputs.k_pct : inputs.k_pct;
  const promised = inputs.promised_pct === undefined ? base.inputs.promised_pct : inputs.promised_pct;
  const offerPrice = inputs.offer_price_pct === undefined ? base.inputs.offer_price_pct : inputs.offer_price_pct;
  const r: R = structuredClone(base);

  /* ликвидность */
  const L = liquidityLine(r, pos);
  r.liquidity.position_size = pos;
  r.liquidity.share_pct = L.share_pct;
  r.liquidity.exit_now_money = L.exit_now_money;
  r.liquidity.exit_days = L.exit_days;
  r.liquidity.line = L.line;

  /* комиссии и налог */
  const fee = feesLine(r.fees_tax.k_grid, k);
  r.fees_tax.k_pct = k ?? null;
  r.fees_tax.pre_tax_pct = fee.pre;
  r.fees_tax.post_tax_pct = fee.post;
  r.fees_tax.line = fee.line;

  /* заявленная доходность и флаг 12 */
  const main = r.yield.main_pct;
  const F12 = flag12(promised ?? null, main);
  const gap = F12.gap;
  r.claim.promised_pct = promised ?? null;
  if (inputs.promised_text !== undefined) r.claim.promised_text = inputs.promised_text;
  if (promised == null) r.claim.promised_text = null;
  r.claim.source = promised == null ? null : inputs.promised_source ?? r.claim.source ?? "field";
  r.claim.gap_pp = gap == null ? null : round2(gap);
  r.claim.line =
    promised == null || main == null || r.status.kind === "not_traded"
      ? null
      : `Обещали: ${fmtMax(promised, 2)}% · На самом деле: ${fmt(main, 2)}% · Разница: ${fmt(Math.abs(gap ?? 0), 1)} п.п.`;

  const f12 = r.flags.find((f) => f.id === 12);
  if (f12) { f12.fired = F12.fired; f12.points = F12.points; f12.details = F12.details; }

  /* Truth Score */
  const fired = r.flags.filter((f) => f.fired).sort((a, c) => c.points - a.points);
  const score = Math.max(0, 100 - fired.reduce((s, f) => s + f.points, 0));
  r.truth_score = {
    score,
    grade: gradeOf(score),
    top3: fired.slice(0, 3).map((f) => f.id),
    more_count: Math.max(0, fired.length - 3),
    none_fired: fired.length === 0,
  };

  /* worst-case: тексты, зависящие от позиции */
  const premium = r.flags.find((f) => f.id === 3)?.fired ?? false;
  for (const w of r.worst) {
    if (w.id === "rates" && r.product.coupon_kind !== "float" && w.loss_pct_1pp != null && w.loss_pct_3pp != null)
      w.text = worstRatesText(w.loss_pct_1pp, w.loss_pct_3pp, pos, r.yield.horizon_label ?? "погашения");
    else if (w.id === "default") w.text = worstDefaultText(pos, premium);
    else if (w.id === "fx") w.text = worstFxText(pos);
  }

  r.inputs = { position_size: pos, k_pct: k ?? null, promised_pct: promised ?? null, offer_price_pct: offerPrice ?? null };
  r.panels = composePanels(r);
  return r;
}

/** Цена предложения меняет доходность — нужна полная пересборка движком (build). */
export function needsRebuild(r: R, inputs: ReportInputs): boolean {
  return inputs.offer_price_pct !== undefined && inputs.offer_price_pct !== r.inputs.offer_price_pct;
}
