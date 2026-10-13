/**
 * Метрики базового отчёта — порт проверенной логики прототипа v2 (harness/comp.js).
 * Время потоков и горизонтов — от даты расчётов (BondFacts.settleIso = SETTLEDATE №1), как у биржи:
 * свой расчёт от даты расчётов совпадает с EFFECTIVEYIELDWAPRICE (от todayIso расходился на 0,1–0,7 п.п.
 * у коротких бумаг, аудит 09.10.2026); «через N дней» для пользователя — по-прежнему от todayIso.
 * Биржевая доходность — одна пара «доходность ↔ цена» из цепочки ISS (BondFacts.moexPairs, выбор в facts.ts); главная (useMoex)
 * только когда цена пары совпадает с показанной (moexAtShownPrice), иначе main = own; ровно 0 от ISS = «не рассчитано».
 * Горизонт main — эффективный (WP-F): у колл-бумаги с фиксированным купоном это колл, когда биржевая доходность главная и биржа
 * считает её к коллу (useMoex и YIELDDATETYPE=OFFER) или когда yield-to-worst заменил main на свою доходность к коллу; комиссия,
 * налог, k_grid и подписи — к эффективному горизонту; контроль (ownAtMoexPrice) — к горизонту БИРЖИ (like-for-like), который
 * совпадает с эффективным, когда биржевая доходность главная и считается к коллу. У флоатера горизонт сценариев и k_grid — погашение.
 * Гейт расхождения (WP-D, аудит D / R2-01): когда контроль расходится с биржей больше CONFIG.controlFailPp, свой расчёт по графику
 * выплат ненадёжен — главной остаётся биржевая доходность (без yield-to-worst со своим расчётом к коллу), а всё производное от own
 * (k_grid, комиссия/налог, сценарий колла) отчёт не публикует (report.ts по YieldModel.controlFailed).
 * Формулы и тексты — из сводной постановки, разделы «Метрики базового отчёта»
 * и «Red flags и Product Truth Score». Веса и пороги — в CONFIG.
 */
import type { BondFacts } from "./iss/facts";
import { daysBetween, dmy, yearsFrom } from "./iss/facts";

import { CONFIG, gradeOf } from "./config";
import { curWord, daysWord, fmt, fmtMax, mln, pctS, round2, round4, rub, termPhrase } from "./format";
import { flag12, liquidityCategory, worstDefaultText, worstFxText, worstRatesText } from "./inputs";

export { CONFIG } from "./config";
export { curWord, daysWord, fmt, fmtMax, mln, pctS, rub, termPhrase } from "./format";

/* ───── решатель YTM (бисекция, как 2.3.3.1) ───── */
export function solve(P: number, flows: [number, number][]): number | null {
  let lo = -0.9, hi = 3;
  const f = (y: number) => flows.reduce((s, fl) => s + fl[1] / Math.pow(1 + y, fl[0]), 0) - P;
  if (f(lo) * f(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const m = (lo + hi) / 2;
    if (f(lo) * f(m) <= 0) hi = m;
    else lo = m;
  }
  return ((lo + hi) / 2) * 100;
}

/** Сдвиг ставки флоатера по сценарию s∈{1,2,3} (2.3.3.1, блок 2). */
export function shift(s: 1 | 2 | 3, t: number): number {
  const c = CONFIG.scenarios;
  if (s === 1) return 0;
  if (s === 2) return c.down.delta * Math.min(t, c.down.capYears);
  if (t <= c.higherLonger.breakAt) return c.higherLonger.up;
  if (t <= c.higherLonger.flatAt)
    return c.higherLonger.up - (c.higherLonger.up - c.higherLonger.to) * (t - 1);
  return c.higherLonger.to;
}

/* ───── горизонт и потоки ───── */
export interface Horizon { t: number; red: number; label: string; dateIso: string | null; kind: "maturity" | "offer" | "call" }

/** БАЗОВЫЙ горизонт бумаги: put-оферта с датой или погашение. Колл сюда не входит намеренно: колл — право эмитента, и
 *  горизонтом main он становится только по правилу эффективного горизонта в yieldModel (биржа считает к коллу или
 *  yield-to-worst заменил main на call.y) — тогда yieldModel().h = горизонт колла (kind "call"), а horizon(b) остаётся
 *  горизонтом «если колл не исполнят» (own, m.call.y сравнивается с ним). Put без даты — погашение (дата не раскрыта). */
export function horizon(b: BondFacts): Horizon {
  // Горизонт — от даты расчётов, из той же даты, что и t купонов (купон в дату погашения тогда t == tMat и не выпадает).
  // Без MATDATE — DAYSTOREDEMPTION (дни от «сегодня» по МСК) за вычетом дней до расчётов.
  const tMat = b.matIso
    ? yearsFrom(b.settleIso, b.matIso)
    : Math.max(0, (b.daysMat ?? 0) - daysBetween(b.todayIso, b.settleIso)) / 365;
  if (b.offerKind === "put" && b.offerDateIso) {
    const t = yearsFrom(b.settleIso, b.offerDateIso);
    const remain = (b.face ?? 0) - b.amortFuture.filter((a) => a.t < t).reduce((s, a) => s + a.value, 0);
    return { t, red: (remain * (b.offerPrice ?? 100)) / 100, label: "оферты " + dmy(b.offerDateIso), dateIso: b.offerDateIso, kind: "offer" };
  }
  return { t: tMat, red: b.face ?? 0, label: "погашения " + (dmy(b.matIso) ?? "—"), dateIso: b.matIso, kind: "maturity" };
}

function couponFlows(b: BondFacts, tH: number, scen: 1 | 2 | 3): [number, number][] {
  const out: [number, number][] = [];
  for (const c of b.coupons) {
    if (!c.future || c.t > tH + 1e-9) continue;
    let v: number;
    if (b.ctype === "float")
      v = ((b.face ?? 0) * ((b.r0 ?? 0) + shift(scen, c.t))) / 100 * ((b.period ?? 0) / 365);
    else if (c.value != null) v = c.value;
    else v = ((b.face ?? 0) * (b.cp ?? 0)) / 100 * ((b.period ?? 0) / 365);
    out.push([c.t, v]);
  }
  // Амортизация (1.4/1.5): выплаты до горизонта; red горизонта уменьшается у вызывающего
  for (const a of b.amortFuture) if (a.t <= tH + 1e-9) out.push([a.t, a.value]);
  return out;
}

function horizonRed(b: BondFacts, h: Horizon): number {
  if (h.kind !== "offer") {
    const paidBefore = b.amortFuture.filter((a) => a.t < h.t - 1e-9).reduce((s, a) => s + a.value, 0);
    return Math.max(0, (b.face ?? 0) - paidBefore);
  }
  return h.red;
}

export function yieldOf(
  b: BondFacts, cleanPct: number, k: number, scen: 1 | 2 | 3, h: Horizon,
): number | null {
  const P = ((cleanPct * (b.face ?? 0)) / 100 + (b.acc ?? 0)) * (1 + (k || 0) / 100);
  const fl = couponFlows(b, h.t, scen);
  fl.push([h.t, horizonRed(b, h)]);
  return solve(P, fl);
}

/** Доходность после НДФЛ 13% по чистым потокам (2.3.3.3). */
export function afterTax(
  b: BondFacts, cleanPct: number, k: number, scen: 1 | 2 | 3, h: Horizon,
): number | null {
  const t = CONFIG.tax;
  const clean = ((cleanPct * (b.face ?? 0)) / 100) * (1 + (k || 0) / 100);
  const P = ((cleanPct * (b.face ?? 0)) / 100 + (b.acc ?? 0)) * (1 + (k || 0) / 100);
  const cps = couponFlows(b, h.t, scen);
  const fl: [number, number][] = cps.map((c, i) => [
    c[0],
    c[1] - t * Math.max(0, c[1] - (i === 0 ? b.acc ?? 0 : 0)), // НКД уменьшает базу первого купона
  ]);
  const red = horizonRed(b, h);
  const gain = red - clean;
  fl.push([h.t, red - t * Math.max(0, gain) + (gain < 0 ? t * -gain : 0)]); // убыток на погашении уменьшает базу
  return solve(P, fl);
}

/* ───── модель доходности (2.3.3.1 + ветки) ───── */
export interface YieldModel {
  status: "ok" | "noRate" | "noPrice" | "structured" | "perpetual";
  /** Эффективный горизонт main: horizon(b) (погашение/put), либо колл — когда биржа считает к коллу (useMoex и YIELDDATETYPE=OFFER)
   *  или когда main заменён call.y (yield-to-worst). К нему считаются withComm/afterTax здесь и k_grid/подписи в report.ts.
   *  У флоатера остаётся horizon(b): три сценария отчёта считаются к погашению, и k_grid/комиссия должны совпадать с ними. */
  h: Horizon;
  cleanPct: number | null;
  priceFromUser: boolean;
  clean: number | null;
  P: number | null;
  scen: (number | null)[] | null;
  main: number | null;
  /** Свой расчёт к БАЗОВОМУ горизонту horizon(b) — погашение или put-оферта («если колл не исполнят»); к эффективному
   *  горизонту h свой расчёт даёт k_grid[k=0] отчёта (при h = колл он равен call.y). */
  own: number | null;
  /** Свой расчёт ОТ ЦЕНЫ ВЫБРАННОЙ БИРЖЕВОЙ ПАРЫ (moexYPrice) К ГОРИЗОНТУ БИРЖИ — контроль формулы like-for-like по цене и по
   *  горизонту; own считается от показанной цены (WAPRICE/PREVWAPRICE), а внутри дня они расходятся, и контроль ловил бы движение
   *  цены, а не ошибку расчёта (ЧеркизБ2P1 09.10: 1,06 п.п. при одинаковой формуле). Горизонт биржи: колл-бумагу с
   *  YIELDDATETYPE=OFFER она считает к коллу (ТелХолБ2-6: own к погашению 16,32 vs биржа к коллу 17,22 — ложные 0,9 п.п.),
   *  put — к оферте (это уже horizon(b)), иначе — к погашению. */
  ownAtMoexPrice: number | null;
  /** Гейт расхождения (WP-D): |ownAtMoexPrice − moexY| > CONFIG.controlFailPp — свой расчёт по графику выплат не сошёлся с биржевым
   *  (фантомные купоны, удвоение остатка на колле — WP-A), доверять ему нельзя. Считается только там, где есть обе величины
   *  (фиксированный купон и биржевая пара); сравнение — по round2, то же число, что report.ts публикует в control_diff_pp.
   *  При ownAtMoexPrice == null (вырожденный горизонт колла t ≤ 0 → solve() null) гейт молчит СОЗНАТЕЛЬНО: сравнивать own к погашению
   *  с биржей к коллу — не like-for-like; диагностика report.ts с фоллбэком `ownAtMoexPrice ?? own` в этом случае может показать
   *  control_diff_pp > порога при controlFailed=false — валидатор пометит «гейт не сработал» (R2-05, план WP-F (е); здесь не чинится).
   *  Следствия: при useMoex главной остаётся биржевая без замены на min(main, call.y), m.h = горизонт биржи; при !useMoex (цена от
   *  пользователя, валютный выпуск, нет пары к показанной цене) main = own как и без гейта — включая yield-to-worst min(main, call.y),
   *  то есть main может оказаться собственной доходностью к коллу (известное ограничение WP-D → WP-G/T). Производное от own (k_grid,
   *  комиссия/налог, worst.call с датой — доходность к коллу или доход за период) при true отчёт не публикует; элемент call без даты
   *  own-числа не несёт и остаётся. */
  controlFailed: boolean;
  useMoex: boolean;
  withComm: number | null;
  afterTax: number | null;
  call: { days: number; dateIso: string; gain: number; gainPct: number; y: number | null; short: boolean } | null;
}

export function yieldModel(
  b: BondFacts,
  opts: { k?: number | null; userPrice?: number | null },
): YieldModel {
  const k = opts.k ?? 0;
  const h = horizon(b); // базовый горизонт: погашение или put-оферта
  // Горизонт колла — строится здесь, до контроля и комиссий/налога: он может стать эффективным горизонтом main (блок колла ниже)
  // и горизонтом биржи для контроля like-for-like. t — от даты расчётов, как у купонов. hc.red = номинал × цена колла участвует
  // ТОЛЬКО в m.call.gain (period_income): yieldOf/afterTax берут остаток через horizonRed(), которая для kind "call" цену колла
  // (BUYBACKPRICE ≠ 100) и амортизацию в дату колла пока не учитывает — оба пункта A.4 (WP-A), здесь не чинится.
  const hc: Horizon | null =
    b.offerKind === "call" && b.offerDateIso
      ? { t: yearsFrom(b.settleIso, b.offerDateIso), red: ((b.face ?? 0) * (b.offerPrice ?? 100)) / 100, label: "колла " + dmy(b.offerDateIso), dateIso: b.offerDateIso, kind: "call" }
      : null;
  // Горизонт биржи для выбранной пары: колл-бумагу с YIELDDATETYPE=OFFER биржа считает к коллу; put — к оферте (это уже h);
  // при MATDATE (или без датотипа) — к погашению. Только датотип OFFER у колл-бумаги означает «к коллу».
  const hMoex: Horizon = hc && b.moexYDatetype === "OFFER" ? hc : h;
  const cleanPct = opts.userPrice ?? b.wap ?? b.prevWap ?? null;
  const prevUsed = opts.userPrice == null && b.wap == null && b.prevWap != null;
  const m: YieldModel = {
    status: "ok", h, cleanPct, priceFromUser: opts.userPrice != null,
    clean: null, P: null, scen: null, main: null, own: null, ownAtMoexPrice: null, controlFailed: false, useMoex: false,
    withComm: null, afterTax: null, call: null,
  };
  void prevUsed;
  // Структурная нота: выплата зависит от базового актива — по купону и цене доходность не считается (биржа отдаёт 0).
  // Бессрочная: горизонта «погашение» нет — доходность к погашению не определена.
  if (b.structured) { m.status = "structured"; return m; }
  if (b.perpetual) { m.status = "perpetual"; return m; }
  if (b.ctype === "float" && b.r0 == null) { m.status = "noRate"; return m; }
  if (cleanPct == null) { m.status = "noPrice"; return m; }
  m.clean = (cleanPct * (b.face ?? 0)) / 100;
  m.P = m.clean + (b.acc ?? 0);

  if (b.ctype === "float") {
    m.scen = ([1, 2, 3] as const).map((s) => yieldOf(b, cleanPct, 0, s, h));
    m.main = m.scen[0];
    m.own = m.scen[0];
  } else {
    m.own = yieldOf(b, cleanPct, 0, 1, h);
    // Контроль like-for-like: та же цена (moexYPrice) и тот же горизонт (hMoex), что у биржевого числа
    if (b.moexY != null && b.moexYPrice != null) m.ownAtMoexPrice = yieldOf(b, b.moexYPrice, 0, 1, hMoex);
    // Гейт расхождения (WP-D): контроль не сошёлся с биржей больше controlFailPp — свой расчёт ненадёжен. То же округлённое число,
    // что в report.ts (control_diff_pp), чтобы control_failed и диагностика не разошлись на границе порога.
    const controlDiffPp = m.ownAtMoexPrice != null && b.moexY != null ? round2(Math.abs(m.ownAtMoexPrice - b.moexY)) : null;
    m.controlFailed = controlDiffPp != null && controlDiffPp > CONFIG.controlFailPp;
    // Биржевая доходность — главная (вопрос 4), но только из ОДНОЙ пары с показанной ценой: facts.ts выбирает по цепочке
    // EFFECTIVEYIELDWAPRICE↔WAPRICE → YIELDATWAPRICE↔WAPRICE → YIELDATPREVWAPRICE↔PREVWAPRICE пару, чья цена == wap ?? prevWap
    // (b.moexAtShownPrice). Пары к показанной цене нет (ISS не отдал доходность к ней) — main = own от показанной цены, а не
    // биржевая доходность от другой (вчерашней) цены; биржевое число остаётся в exchange и в контроле. Цена от пользователя — own.
    // Свой расчёт от цены той же пары (ownAtMoexPrice) — контроль (>0,5 п.п. — предупреждение).
    m.useMoex = !m.priceFromUser && b.moexY != null && b.moexAtShownPrice && (b.fu === "SUR" || b.fu === "RUB");
    m.main = m.useMoex ? b.moexY : m.own;
  }
  if (hc && b.offerDateIso) {
    const days = daysBetween(b.todayIso, b.offerDateIso); // «через N дней» — от сегодня, как флаг 8 и product.offer.days_to
    const cps = couponFlows(b, hc.t, 1); // потоки — от даты расчётов (hc.t)
    const recv = cps.reduce((s, c) => s + c[1], 0) + hc.red;
    const gain = recv - (m.P ?? 0);
    m.call = {
      days, dateIso: b.offerDateIso, gain, gainPct: (gain / (m.P ?? 1)) * 100,
      y: yieldOf(b, cleanPct, 0, 1, hc), short: days < CONFIG.flags.callSoonDays,
    };
    // Эффективный горизонт main (WP-F). Число main при этом не «переезжает» на другой горизонт — меняется только то,
    // К ЧЕМУ оно подписано и к чему считаются комиссия/налог/k_grid:
    //  (а) биржевая доходность главная и биржа считает к коллу (hMoex === hc, YIELDDATETYPE=OFFER) → main = moexY как есть,
    //      горизонт — колл: число и раньше было к коллу, ошибочной была подпись «к погашению» (ТелХолБ2-6, аудит §F);
    //  (б) иначе yield-to-worst: своя доходность к коллу ниже main → main = call.y и горизонт — колл (прежний min, теперь с горизонтом);
    //  (в) иначе горизонт остаётся базовым h (погашение): к коллу выгоднее, эмитент его, скорее всего, не исполнит.
    // Короткий колл (short, < callSoonDays) — ветка period_income в отчёте: горизонт остаётся базовым, подписи «к погашению».
    // Биржевая доходность с YIELDDATETYPE=MATDATE у колл-бумаги горизонт не меняет — биржа считает её к погашению.
    // Флоатер: число main = min(scen[0], call.y) — как до WP-F, но горизонт НЕ переключается: блок yield у флоатера — три сценария
    // к погашению (report.ts, ветка scenarios), и k_grid/комиссия обязаны совпадать с заголовком «ставки не меняются», а не с
    // call.y (ЧеркизБ2P2 при колле дальше callSoonDays: 17,19 в заголовке против 15,73 «без комиссии» — ревью WP-F).
    // Правило (а) у флоатера не возникает: useMoex ставится только в ветке фиксированного купона.
    // Гейт (WP-D): при controlFailed и useMoex свой расчёт к коллу (call.y) ненадёжен — main остаётся биржевой без правила (б),
    // горизонт — горизонт биржи hMoex (колл при YIELDDATETYPE=OFFER, иначе погашение). При !useMoex main = own как и без гейта,
    // включая правило (б): биржи к показанной цене в main нет, свой расчёт — единственный (его ненадёжность — в сигнале отчёта).
    if (!m.call.short) {
      if (m.controlFailed && m.useMoex) m.h = hMoex;
      else if (m.useMoex && hMoex === hc) m.h = hc;
      else if (m.call.y != null && m.main != null && m.call.y < m.main) {
        m.main = m.call.y;
        if (b.ctype !== "float") m.h = hc;
      }
    }
  }
  // Комиссия и налог — к эффективному горизонту m.h («одна величина — одно значение»: k_grid отчёта считается к тому же m.h)
  if (k) m.withComm = yieldOf(b, cleanPct, k, 1, m.h);
  m.afterTax = afterTax(b, cleanPct, k, 1, m.h);
  return m;
}

/* ───── ликвидность (2.3.3.2) ───── */
export interface Liquidity {
  avg: number | null; cat: "норм" | "умеренно" | "низкая" | "—";
  spread: number | null; missing: boolean;
  share: number | null; days: number | null;
  exitPct: number | null; exitCost: number | null; exitDays: number | null;
  noExit: boolean; // текст от позиции собирает inputs.liquidityLine
}

export function liquidity(b: BondFacts, pos: number): Liquidity {
  const avg = b.avg;
  const denom = b.wap ?? b.prevWap; // знаменатель спреда: WAPRICE, иначе PREVWAPRICE (П16)
  const missing = b.bid == null || b.offerQ == null;
  const spread = !missing && denom ? ((b.offerQ! - b.bid!) / denom) * 100 : null;
  let share: number | null = null, days: number | null = null;
  if (avg && avg > 0) { share = (pos / avg) * 100; days = pos / (avg * CONFIG.liq.dayShare); }
  // Категория — от оборота и позиции (U.21: позиция больше среднего дневного оборота — «низкая»): та же функция, что в applyInputs,
  // от того же оборота, что попадает в контракт (avg_turnover округлён до рубля), — сборка и пересчёт на странице совпадают
  const cat: Liquidity["cat"] = liquidityCategory(!b.stop, avg == null ? null : Math.round(avg), pos);
  const exitPct = spread == null ? null : spread / 2;
  const exitDays = days == null ? null : Math.max(1, Math.ceil(days));
  const noExit = b.stop || avg === 0;
  return {
    avg, cat, spread, missing, share, days, exitPct,
    exitCost: exitPct == null ? null : (pos * exitPct) / 100, exitDays, noExit,
  };
}

/* ───── red flags и Truth Score (2.3.3.5) ───── */
export interface Flag {
  id: number; title: string; text: string; fired: boolean; points: number; details: string;
}
export interface FlagsResult {
  all: Flag[]; fired: Flag[]; score: number; grade: string;
  gap: number | null; prem: boolean; fx: boolean; callSoon: boolean; illiq: boolean;
}

export function flags(
  b: BondFacts, ym: YieldModel, liq: Liquidity, claimed: number | null,
): FlagsResult {
  const C = CONFIG.flags;
  const F: Flag[] = [];
  const add = (id: number, title: string, text: string, fired: boolean, pts: number, details: string) =>
    F.push({ id, title, text, fired, points: fired ? pts : 0, details });
  const fl = b.ctype === "float";

  add(1, "Только для квалифицированных инвесторов",
    "Регулятор признал инструмент сложным для массового инвестора.",
    b.qual, C.qualPts, "ISQUALIFIEDINVESTORS = " + (b.qual ? 1 : 0));
  add(2, "Низкий уровень листинга",
    "Минимальные требования биржи к эмитенту по раскрытию информации.",
    b.lvl === 3, C.listPts, "LISTLEVEL = " + (b.lvl ?? "—"));
  const prem = !fl && b.g != null && b.g > C.premiumBp;
  add(3, "Высокая премия за риск",
    "Рынок оценивает кредитный риск эмитента как существенный.",
    prem, b.g != null && b.g > C.premiumHighBp ? C.premiumHighPts : C.premiumPts,
    fl ? "не считается для флоатеров" : "GSPREADBP = " + (b.g ?? "нет") + " б.п.");
  // Нет данных о торгах у торгуемой бумаги — это тоже «мало сделок», а не «неизвестно»
  const illiq = !b.stop && (b.avg == null || b.avg < C.illiqTurnover || (b.avgNT ?? 0) < C.illiqTrades);
  add(4, "Неликвидный выпуск",
    "Мало оборота или сделок — выйти из позиции сложно.",
    illiq, C.illiqPts,
    b.nDays ? `за ${b.nDays} дн.: ${mln(b.avg)}/день, ${fmt(b.avgNT ?? 0, 0)} сделок/день` : `сделок за последние ${CONFIG.liq.windowDays} дней не было`);
  add(5, "Широкий спред",
    liq.missing
      ? "В стакане нет встречных заявок — быстро продать по справедливой цене нельзя."
      : "Большая разница между ценой покупки и продажи — потеря при каждой сделке.",
    // у бумаги без торгов стакана нет по определению — это уже флаг 6, пустой спред не штрафуем второй раз
    !b.stop && (liq.missing || (liq.spread != null && liq.spread > C.spreadPct)), C.spreadPts,
    b.stop ? "не считается: торгов нет (флаг 6)" : liq.missing ? "нет BID или OFFER" : "спред " + pctS(liq.spread));
  add(6, "Не торгуется", "Биржевых торгов нет — выйти через биржу нельзя.",
    b.stop, C.notTradedPts, !b.stop ? "торгуется" : b.boardid ? "is_traded = 0" : "нет режима биржевых торгов bonds/stock");
  const durY = (b.durDays ?? 0) / 365;
  add(7, "Длинная дюрация", "Цена сильно реагирует на изменение ставок.",
    !fl && durY > C.longDurYears, C.longDurPts,
    fl ? "не считается для флоатеров" : "DURATION = " + fmt(durY, 1) + " г.");
  const call = b.offerKind === "call";
  const daysOffer = b.offerDateIso
    ? Math.round((Date.parse(b.offerDateIso) - Date.parse(b.todayIso)) / 86_400_000)
    : null;
  const callSoon = call && daysOffer != null && daysOffer <= C.callSoonDays;
  add(8, "Эмитент может погасить досрочно (call)",
    callSoon
      ? `Досрочное погашение возможно уже ${dmy(b.offerDateIso)} — через ${daysWord(daysOffer!)}.`
      : "Эмитент может погасить выпуск в выгодный для себя момент.",
    call, callSoon ? C.callSoonPts : C.callPts,
    call ? (b.offerDateIso ? "CALLOPTIONDATE = " + dmy(b.offerDateIso) : "дата не раскрыта") : "нет");
  add(9, "Ставка после оферты неизвестна", "После оферты ставку купона назначит эмитент.",
    b.reset, C.resetPts,
    b.reset ? `купоны после ${b.offerDateIso ? dmy(b.offerDateIso) : "оферты"} не объявлены` : "нет");
  const fx = b.fu !== "SUR" && b.fu !== "RUB";
  add(10, "Валютный риск", "Номинал не в рублях — к риску облигации добавляется курсовой.",
    fx, C.fxPts, "FACEUNIT = " + b.fu);
  add(11, "Плавающий купон", "Доход зависит от рыночной ставки и снизится вместе с ней.",
    fl, C.floatPts, fl ? "BONDTYPE: плавающий" : "купон постоянный");
  const F12 = flag12(claimed, ym.main);
  const gap = F12.gap;
  add(12, "Обещанная доходность выше реальной",
    "Вам обещали больше, чем бумага даёт на самом деле.",
    F12.fired, F12.points, F12.details);
  add(13, "Дефолт в истории выпуска", "По выпуску уже был дефолт или технический дефолт.",
    b.hasDefault, C.defaultPts, b.hasDefault ? "HASDEFAULT = 1" : "нет");
  add(14, "Структурный продукт",
    "Выплата зависит от базового актива или события, а не от купона — можно получить меньше номинала или только номинал.",
    b.structured, C.structuredPts, b.structured ? "STRUCTBOND = 1" : "нет");
  add(15, b.subordinated ? "Бессрочная субординированная" : "Бессрочная",
    b.subordinated
      ? "Даты погашения нет; банк вправе отменить купон и списать номинал при снижении капитала — это не депозит."
      : "Даты погашения нет — вернуть номинал можно только продажей на бирже или по решению эмитента о выкупе.",
    b.perpetual, C.perpetualPts, b.perpetual ? "BOND_SUBTYPE = Бессрочные" + (b.subordinated ? ", SUBORDBOND = 1" : "") : "нет");

  const fired = F.filter((f) => f.fired).sort((a, c) => c.points - a.points);
  const score = Math.max(0, 100 - fired.reduce((s, f) => s + f.points, 0));
  const grade = gradeOf(score);
  return { all: F, fired, score, grade, gap, prem, fx, callSoon, illiq };
}

/* ───── worst-case (2.3.3.4) ───── */
export function dmod(b: BondFacts, ym: YieldModel): number {
  const y = ym.main ?? 0;
  const days = b.ctype === "float"
    ? (b.nextCouponIso ? Math.max(0, (Date.parse(b.nextCouponIso) - Date.parse(b.todayIso)) / 86_400_000) : 0)
    : b.durDays ?? 0;
  return days / 365 / (1 + y / 100);
}

export interface WorstItem { id: string; title: string; text: string; loss_pct_1pp: number | null; loss_pct_3pp: number | null }

export function worst(
  b: BondFacts, ym: YieldModel, F: FlagsResult, pos: number,
): { list: WorstItem[]; d1: number; d3: number } {
  const W: WorstItem[] = [];
  const add = (id: string, title: string, text: string, l1: number | null = null, l3: number | null = null) =>
    W.push({ id, title, text, loss_pct_1pp: l1, loss_pct_3pp: l3 });
  const dm = dmod(b, ym);
  // Потери в % храним с точностью 4 знака — тексты от позиции пересобирает applyInputs по этим полям
  const d1 = round4(dm), d3 = round4(dm * 3);
  if (b.ctype === "float")
    add("rates", "Рост ставок",
      `Купон пересматривается каждые ${daysWord(b.period ?? 0)}, поэтому цена почти не реагирует на ставки: при росте на 3 п.п. — ${d3 < 0.1 ? "менее 0,1%" : "около −" + fmt(d3, 1) + "%"}.`, d1, d3);
  else add("rates", "Рост ставок", worstRatesText(d1, d3, pos, ym.h.label), d1, d3);
  add("default", "Дефолт эмитента", worstDefaultText(pos, F.prem));
  if (b.offerKind === "call") {
    if (ym.call?.short)
      add("call", "Досрочное погашение",
        `Если эмитент погасит выпуск ${dmy(ym.call.dateIso)}, за ${daysWord(ym.call.days)} вы получите ${fmt(ym.call.gain, 2)} ₽ на облигацию (${fmt(ym.call.gainPct, 2)}%), а деньги придётся размещать заново.`);
    else if (ym.call)
      add("call", "Досрочное погашение",
        `Если эмитент погасит выпуск ${dmy(ym.call.dateIso)}, доходность составит ${pctS(ym.call.y)}.`);
    else
      add("call", "Досрочное погашение",
        "Эмитент может погасить выпуск раньше срока; дата в данных биржи не раскрыта.");
  }
  if (b.ctype === "float" && ym.scen)
    add("float-down", "Снижение ставок",
      `Если ставки снизятся на 2,5 п.п. за год, доходность составит ${pctS(ym.scen[1])} вместо ${pctS(ym.scen[0])}.`);
  if (F.fx)
    add("fx", "Курс валюты", worstFxText(pos));
  if (b.reset)
    add("reset", "Ставка после оферты",
      b.offerDateIso
        ? `Если не предъявить бумагу к выкупу ${dmy(b.offerDateIso)}, дальше ставку назначит эмитент — она может быть ниже рынка.`
        : "Если не предъявить бумагу к выкупу в дату оферты, которую эмитент не раскрыл, дальше ставку назначит эмитент — она может быть ниже рынка.");
  return { list: W, d1, d3 };
}

/* ───── шаблон «что это за продукт» (П5, П6) ───── */
export function plainText(b: BondFacts): string {
  let c: string;
  if (b.ctype === "fixed") c = `фиксированный купон ${fmtMax(b.cp ?? 0, 2)}% годовых`;
  else if (b.ctype === "float")
    c = b.r0 ? `плавающий купон, сейчас ≈ ${fmt(b.r0, 1)}% годовых` : "плавающий купон";
  else c = "без купона — доход в разнице цены и номинала";
  let o: string;
  if (b.offerKind === "put")
    // Дата оферты у put может быть не раскрыта (R2-14): тогда без слота даты и без «в эту дату»
    o = b.offerDateIso
      ? `с офертой ${dmy(b.offerDateIso)}: в эту дату бумагу можно предъявить к выкупу по ${fmtMax(b.offerPrice ?? 100, 2)}%`
      : `с офертой (дата не раскрыта): бумагу можно предъявить к выкупу по ${fmtMax(b.offerPrice ?? 100, 2)}%`;
  else if (b.offerKind === "call")
    o = b.offerDateIso
      ? `эмитент может погасить досрочно ${dmy(b.offerDateIso)}`
      : "эмитент может погасить досрочно, дата в данных биржи не указана";
  else o = "без оферты";
  const amort = b.amortized ? "с амортизацией" : "без амортизации";
  if (b.structured)
    return `Структурная облигация ${b.emit ?? ""} на ${termPhrase(b.daysMat ?? 0)}: купон ${fmtMax(b.cp ?? 0, 2)}%, основная выплата зависит от базового актива или события — условия в решении о выпуске, по биржевым данным не видны. ${b.qual ? "Только для квалифицированных инвесторов. " : ""}Номинал в ${curWord(b.fu)}.`;
  if (b.perpetual)
    return `${b.subordinated ? "Бессрочная субординированная облигация" : "Бессрочная облигация"} ${b.emit ?? ""}: даты погашения нет, ${c}, ${o}. ${b.subordinated ? "Купон может быть отменён, номинал — списан при снижении капитала банка. " : ""}Номинал в ${curWord(b.fu)}.`;
  return `${b.kind ?? "Облигация"} ${b.emit ?? ""} на ${termPhrase(b.daysMat ?? 0)}, ${c}, ${amort}, ${o}. Номинал в ${curWord(b.fu)}.`;
}
