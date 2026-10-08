/**
 * Метрики базового отчёта — порт проверенной логики прототипа v2 (harness/comp.js),
 * сверенной с живым ISS 08.10.2026 (расхождение с EFFECTIVEYIELDWAPRICE ≤ 0,03 п.п.).
 * Формулы и тексты — из сводной постановки, разделы «Метрики базового отчёта»
 * и «Red flags и Product Truth Score». Веса и пороги — в CONFIG.
 */
import type { BondFacts } from "./iss/facts.js";
import { dmy } from "./iss/facts.js";

export const CONFIG = {
  tax: 0.13,
  positionDefault: 500_000,
  kGrid: [0, 0.1, 0.3, 0.5, 1] as const,
  scenarios: {
    down: { delta: -2.5, capYears: 1 }, // Δ = −2,5 п.п. × min(t, 1)
    higherLonger: { up: 1.5, to: -1.5, breakAt: 1, flatAt: 2 },
  },
  flags: {
    premiumBp: 600, premiumHighBp: 1000, premiumPts: 20, premiumHighPts: 30,
    illiqTurnover: 1_000_000, illiqTrades: 10, illiqPts: 15,
    spreadPct: 1, spreadPts: 10,
    notTradedPts: 40,
    longDurYears: 5, longDurPts: 5,
    callPts: 10, callSoonDays: 30, callSoonPts: 15,
    resetPts: 5, fxPts: 5, floatPts: 5,
    gapPp: 2, gapHighPp: 5, gapPts: 20, gapHighPts: 30,
    qualPts: 10, listPts: 10, defaultPts: 40,
  },
  grades: [
    [85, "Прозрачный продукт"],
    [70, "Есть оговорки"],
    [50, "Много рисков"],
    [0, "Высокий риск"],
  ] as const,
  liq: { goodTurnover: 10e6, midTurnover: 1e6, dayShare: 0.2 },
  controlWarnPp: 0.5,
};

/* ───── форматирование (ru-RU, как в постановке) ───── */
export const fmt = (x: number, d: number) =>
  new Intl.NumberFormat("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }).format(x);
export const fmtMax = (x: number, d: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: d }).format(x);
export const pctS = (x: number | null) => (x == null ? "—" : fmt(x, 2) + "%");
export const rub = (x: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(x)) + " ₽";
export const mln = (x: number | null) => {
  if (x == null) return "—";
  if (x >= 1e9) return fmt(x / 1e9, 2) + " млрд ₽";
  if (x >= 1e6) return fmt(x / 1e6, 1) + " млн ₽";
  if (x >= 1e3) return fmt(x / 1e3, 0) + " тыс. ₽";
  return fmt(x, 0) + " ₽";
};
export const daysWord = (n: number) => {
  const w =
    n % 10 === 1 && n % 100 !== 11 ? "день"
    : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "дня"
    : "дней";
  return `${n} ${w}`;
};
export const termPhrase = (days: number) => {
  const y = days / 365;
  if (y < 1) return Math.max(1, Math.round(days / 30.4)) + " мес.";
  const r = Math.round(y * 10) / 10;
  const s = fmtMax(r, 1);
  if (Number.isInteger(r)) {
    const w =
      r % 10 === 1 && r % 100 !== 11 ? "год"
      : [2, 3, 4].includes(r % 10) && ![12, 13, 14].includes(r % 100) ? "года"
      : "лет";
    return `${s} ${w}`;
  }
  return s + " года";
};
export const curWord = (fu: string) =>
  fu === "SUR" || fu === "RUB" ? "рублях" : fu === "CNY" ? "юанях" : fu === "USD" ? "долларах" : fu === "EUR" ? "евро" : fu;

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

export function horizon(b: BondFacts): Horizon {
  const tMat = (b.daysMat ?? 0) / 365;
  if (b.offerKind === "put" && b.offerDateIso) {
    const t = (Date.parse(b.offerDateIso) - Date.parse(b.todayIso)) / 86_400_000 / 365;
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
  status: "ok" | "noRate" | "noPrice";
  h: Horizon;
  cleanPct: number | null;
  priceFromUser: boolean;
  clean: number | null;
  P: number | null;
  scen: (number | null)[] | null;
  main: number | null;
  own: number | null;
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
  const h = horizon(b);
  const cleanPct = opts.userPrice ?? b.wap ?? b.prevWap ?? null;
  const prevUsed = opts.userPrice == null && b.wap == null && b.prevWap != null;
  const m: YieldModel = {
    status: "ok", h, cleanPct, priceFromUser: opts.userPrice != null,
    clean: null, P: null, scen: null, main: null, own: null, useMoex: false,
    withComm: null, afterTax: null, call: null,
  };
  void prevUsed;
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
    // Биржевую пару WAPRICE → EFFECTIVEYIELDWAPRICE используем как основную (вопрос 4);
    // свой расчёт — контроль (>0,5 п.п. — предупреждение)
    m.useMoex = !m.priceFromUser && b.moexY != null && (b.fu === "SUR" || b.fu === "RUB");
    m.main = m.useMoex ? b.moexY : m.own;
  }
  if (k) m.withComm = yieldOf(b, cleanPct, k, 1, h);
  m.afterTax = afterTax(b, cleanPct, k, 1, h);

  if (b.offerKind === "call" && b.offerDateIso) {
    const tC = (Date.parse(b.offerDateIso) - Date.parse(b.todayIso)) / 86_400_000 / 365;
    const days = Math.round(tC * 365);
    const hc: Horizon = { t: tC, red: ((b.face ?? 0) * (b.offerPrice ?? 100)) / 100, label: "колла " + dmy(b.offerDateIso), dateIso: b.offerDateIso, kind: "call" };
    const cps = couponFlows(b, tC, 1);
    const recv = cps.reduce((s, c) => s + c[1], 0) + hc.red;
    const gain = recv - (m.P ?? 0);
    m.call = {
      days, dateIso: b.offerDateIso, gain, gainPct: (gain / (m.P ?? 1)) * 100,
      y: yieldOf(b, cleanPct, 0, 1, hc), short: days < CONFIG.flags.callSoonDays,
    };
    if (!m.call.short && m.call.y != null && m.main != null) m.main = Math.min(m.main, m.call.y);
  }
  return m;
}

/* ───── ликвидность (2.3.3.2) ───── */
export interface Liquidity {
  avg: number | null; cat: "норм" | "умеренно" | "низкая" | "—";
  spread: number | null; missing: boolean;
  share: number | null; days: number | null;
  exitPct: number | null; exitCost: number | null; exitDays: number | null;
  noExit: boolean; summary: string;
}

export function liquidity(b: BondFacts, pos: number): Liquidity {
  const avg = b.avg;
  const denom = b.wap ?? b.prevWap; // знаменатель спреда: WAPRICE, иначе PREVWAPRICE (П16)
  const missing = b.bid == null || b.offerQ == null;
  const spread = !missing && denom ? ((b.offerQ! - b.bid!) / denom) * 100 : null;
  let share: number | null = null, days: number | null = null;
  if (avg && avg > 0) { share = (pos / avg) * 100; days = pos / (avg * CONFIG.liq.dayShare); }
  const cat: Liquidity["cat"] =
    avg == null ? "—" : avg > CONFIG.liq.goodTurnover ? "норм" : avg >= CONFIG.liq.midTurnover ? "умеренно" : "низкая";
  const exitPct = spread == null ? null : spread / 2;
  const exitDays = days == null ? null : Math.max(1, Math.ceil(days));
  const noExit = b.stop || avg === 0;
  let summary: string;
  if (b.stop) summary = "Биржевых торгов по бумаге нет — выйти через биржу нельзя.";
  else if (!avg)
    summary = `За последние ${b.nDays} торговых дней по бумаге не было сделок — выйти через биржу сейчас нельзя. Категория ликвидности — низкая.`;
  else
    summary =
      `При позиции ${rub(pos)} стоимость моментального выхода ≈ ` +
      (exitPct == null ? "не определить: в стакане нет встречных заявок" : fmt(exitPct, 2) + "%") +
      `, аккуратного выхода ≈ ${daysWord(exitDays!)}. Категория ликвидности — ${cat}.`;
  return {
    avg, cat, spread, missing, share, days, exitPct,
    exitCost: exitPct == null ? null : (pos * exitPct) / 100, exitDays, noExit, summary,
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
  const illiq = b.avg != null && (b.avg < C.illiqTurnover || (b.avgNT ?? 0) < C.illiqTrades);
  add(4, "Неликвидный выпуск",
    "Мало оборота или сделок — выйти из позиции сложно.",
    illiq, C.illiqPts,
    `за ${b.nDays} дн.: ${mln(b.avg)}/день, ${fmt(b.avgNT ?? 0, 0)} сделок/день`);
  add(5, "Широкий спред",
    liq.missing
      ? "В стакане нет встречных заявок — быстро продать по справедливой цене нельзя."
      : "Большая разница между ценой покупки и продажи — потеря при каждой сделке.",
    liq.missing || (liq.spread != null && liq.spread > C.spreadPct), C.spreadPts,
    liq.missing ? "нет BID или OFFER" : "спред " + pctS(liq.spread));
  add(6, "Не торгуется", "Биржевых торгов нет — выйти через биржу нельзя.",
    b.stop, C.notTradedPts, b.stop ? "is_traded = 0" : "торгуется");
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
    b.reset ? `купоны после ${dmy(b.offerDateIso)} не объявлены` : "нет");
  const fx = b.fu !== "SUR" && b.fu !== "RUB";
  add(10, "Валютный риск", "Номинал не в рублях — к риску облигации добавляется курсовой.",
    fx, C.fxPts, "FACEUNIT = " + b.fu);
  add(11, "Плавающий купон", "Доход зависит от рыночной ставки и снизится вместе с ней.",
    fl, C.floatPts, fl ? "BONDTYPE: плавающий" : "купон постоянный");
  const gap = claimed != null && ym.main != null ? claimed - ym.main : null;
  add(12, "Обещанная доходность выше реальной",
    "Вам обещали больше, чем бумага даёт на самом деле.",
    gap != null && gap > C.gapPp, gap != null && gap > C.gapHighPp ? C.gapHighPts : C.gapPts,
    gap == null ? "заявленная не указана" : `обещали ${fmtMax(claimed!, 2)}%, расчётная ${pctS(ym.main)}`);
  add(13, "Дефолт в истории выпуска", "По выпуску уже был дефолт или технический дефолт.",
    b.hasDefault, C.defaultPts, b.hasDefault ? "HASDEFAULT = 1" : "нет");

  const fired = F.filter((f) => f.fired).sort((a, c) => c.points - a.points);
  const score = Math.max(0, 100 - fired.reduce((s, f) => s + f.points, 0));
  const grade = CONFIG.grades.find(([min]) => score >= min)![1];
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

export function worst(
  b: BondFacts, ym: YieldModel, F: FlagsResult, pos: number,
): { list: { id: string; title: string; text: string }[]; d1: number; d3: number } {
  const W: { id: string; title: string; text: string }[] = [];
  const dm = dmod(b, ym);
  const d1 = dm, d3 = dm * 3;
  if (b.ctype === "float")
    W.push({ id: "rates", title: "Рост ставок",
      text: `Купон пересматривается каждые ${daysWord(b.period ?? 0)}, поэтому цена почти не реагирует на ставки: при росте на 3 п.п. — ${d3 < 0.1 ? "менее 0,1%" : "около −" + fmt(d3, 1) + "%"}.` });
  else
    W.push({ id: "rates", title: "Рост ставок",
      text: `При росте ставок на 1 п.п. цена упадёт примерно на ${fmt(d1, 1)}%, на 3 п.п. — на ${fmt(d3, 1)}% (−${rub((pos * d3) / 100)} на вашу позицию). Если держать до ${ym.h.label}, убытка не будет.` });
  W.push({ id: "default", title: "Дефолт эмитента",
    text: `В худшем случае можно потерять вложенное — до ${rub(pos)}.` + (F.prem ? " Рынок оценивает кредитный риск эмитента как высокий." : "") });
  if (b.offerKind === "call") {
    if (ym.call?.short)
      W.push({ id: "call", title: "Досрочное погашение",
        text: `Если эмитент погасит выпуск ${dmy(ym.call.dateIso)}, за ${daysWord(ym.call.days)} вы получите ${fmt(ym.call.gain, 2)} ₽ на облигацию (${fmt(ym.call.gainPct, 2)}%), а деньги придётся размещать заново.` });
    else if (ym.call)
      W.push({ id: "call", title: "Досрочное погашение",
        text: `Если эмитент погасит выпуск ${dmy(ym.call.dateIso)}, доходность составит ${pctS(ym.call.y)}.` });
    else
      W.push({ id: "call", title: "Досрочное погашение",
        text: "Эмитент может погасить выпуск раньше срока; дата в данных биржи не раскрыта." });
  }
  if (b.ctype === "float" && ym.scen)
    W.push({ id: "float-down", title: "Снижение ставок",
      text: `Если ставки снизятся на 2,5 п.п. за год, доходность составит ${pctS(ym.scen[1])} вместо ${pctS(ym.scen[0])}.` });
  if (F.fx)
    W.push({ id: "fx", title: "Курс валюты",
      text: `При укреплении рубля к валюте номинала на 10% рублёвый результат снизится примерно на 10% (−${rub(pos * 0.1)}).` });
  if (b.reset)
    W.push({ id: "reset", title: "Ставка после оферты",
      text: `Если не предъявить бумагу к выкупу ${dmy(b.offerDateIso)}, дальше ставку назначит эмитент — она может быть ниже рынка.` });
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
    o = `с офертой ${dmy(b.offerDateIso)}: в эту дату бумагу можно предъявить к выкупу по ${fmtMax(b.offerPrice ?? 100, 2)}%`;
  else if (b.offerKind === "call")
    o = b.offerDateIso
      ? `эмитент может погасить досрочно ${dmy(b.offerDateIso)}`
      : "эмитент может погасить досрочно, дата в данных биржи не указана";
  else o = "без оферты";
  const amort = b.amortized ? "с амортизацией" : "без амортизации";
  return `${b.kind ?? "Облигация"} ${b.emit ?? ""} на ${termPhrase(b.daysMat ?? 0)}, ${c}, ${amort}, ${o}. Номинал в ${curWord(b.fu)}.`;
}
