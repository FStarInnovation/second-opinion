/**
 * Сбор фактов о бумаге: запросы №1–№4 + поиск → нормализованная структура BondFacts.
 * Поля и правила — из раздела «Источники данных» сводной постановки.
 */
import { issJson, rows, toNum, isoDateOrNull, q, type FetchOptions } from "./client";
import { CONFIG } from "../config";

export interface CouponRow {
  dateIso: string;
  t: number; // лет от даты расчётов (settleIso)
  value: number | null;
  valueprc: number | null;
  future: boolean; // dateIso > settleIso: купон достанется покупателю (выплаченный до расчётов — продавцу, ISS учитывает это в ACCRUEDINT)
}

export interface BondFacts {
  secid: string;
  isin: string | null;
  boardid: string | null;
  shortname: string;
  secname: string | null;
  regnumber: string | null;
  emit: string | null; // emitent_title — из поиска (в №2 его нет, там только EMITTER_ID)
  kind: string | null; // TYPENAME
  /** «Сегодня» — календарный день по МСК (или opts.todayIso). От него: показ «через N дней» (call.days, daysOffer флага 8,
   *  product.offer.days_to), окно №4, дни до купона флоатера в dmod и сдвиг DAYSTOREDEMPTION в фоллбэке горизонта.
   *  Потоки, горизонты, НКД и выбор будущей оферты — от settleIso. */
  todayIso: string;
  /** Дата расчётов сделки — SETTLEDATE №1 securities (T+1; в пятницу — понедельник). Начало отсчёта t ВСЕХ потоков
   *  и горизонтов: так считает биржа (EFFECTIVEYIELDWAPRICE, ACCRUEDINT), и с ней сходится свой расчёт.
   *  Поля нет (нет борда / не торгуется) — следующий рабочий день после todayIso: сб/вс пропускаются, праздники биржи не учитываются. */
  settleIso: string;

  face: number | null; // FACEVALUEONSETTLEDATE №1 (номинал на дату расчётов), иначе FACEVALUE
  fu: string; // FACEUNIT
  acc: number | null; // ACCRUEDINT
  cp: number | null; // COUPONPERCENT
  period: number | null; // COUPONPERIOD, дней
  matIso: string | null;
  daysMat: number | null; // DAYSTOREDEMPTION (№2)
  nextCouponIso: string | null;

  ctype: "fixed" | "float" | "zero" | "linker";
  r0: number | null; // текущая ставка флоатера, % годовых (П9)
  coupons: CouponRow[];
  amortFuture: { t: number; value: number }[]; // без строки maturity
  amortized: boolean;

  offerKind: "put" | "call" | "none";
  offerDateIso: string | null;
  offerPrice: number | null; // % от номинала
  offerPriceAssumedPar: boolean;
  reset: boolean; // put: купоны после оферты не объявлены

  wap: number | null; // WAPRICE, % от номинала
  prevWap: number | null;
  bid: number | null;
  offerQ: number | null; // OFFER (стакан)
  upd: string | null; // UPDATETIME
  tradeDateIso: string | null;

  moexY: number | null; // EFFECTIVEYIELDWAPRICE, иначе YIELDATPREVWAPRICE (№1 securities)
  moexYPrice: number | null; // цена, от которой посчитана moexY
  moexYDatetype: string | null; // MATDATE | OFFER
  g: number | null; // GSPREADBP
  durDays: number | null; // DURATION, дней

  stop: boolean; // флаг 6: is_traded = 0 во всех режимах bonds/stock — или режимов нет вовсе (boardid = null)
  structured: boolean; // STRUCTBOND = 1 / BOND_TYPE «Структурная облигация»: выплата зависит от базового актива, не от купона
  subordinated: boolean; // SUBORDBOND = 1: субординированная (купон можно отменить, номинал — списать)
  perpetual: boolean; // BOND_SUBTYPE «Бессрочные» или нет MATDATE: доходность к погашению не определена
  lvl: number | null; // LISTLEVEL (№2)
  qual: boolean; // ISQUALIFIEDINVESTORS (№2)
  hasDefault: boolean; // HASDEFAULT | HASTECHNICALDEFAULT (№2)

  avg: number | null; // средний оборот за ≤20 торговых дней, ₽ (№4 VALUE)
  avgNT: number | null; // среднее число сделок в день
  nDays: number; // сколько торговых дней посчитано
}

const dmy = (iso: string | null) =>
  iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : null;
export { dmy };

export function yearsFrom(fromIso: string, iso: string): number {
  return (Date.parse(iso) - Date.parse(fromIso)) / 86_400_000 / 365;
}
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/** Календарный день по МСК (UTC+3; в РФ нет перехода на летнее время). С 00:00 до 03:00 МСК день по UTC
 *  на единицу меньше, а биржа (SETTLEDATE, DAYSTOREDEMPTION, окно №4) живёт по МСК — отсюда расходились календари. */
export function mskDay(d = new Date()): string {
  return new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

/** Следующий рабочий день после iso: сб/вс пропускаются, праздники биржи не учитываются (фоллбэк SETTLEDATE) */
function nextBusinessDay(iso: string): string {
  let d = new Date(Date.parse(iso) + 86_400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 86_400_000);
  return d.toISOString().slice(0, 10);
}

export async function collectFacts(
  secid: string,
  opts: FetchOptions & { todayIso?: string } = {},
): Promise<BondFacts> {
  const todayIso = opts.todayIso ?? mskDay();

  const d2 = await issJson(q.n2(secid), opts);
  const desc = Object.fromEntries(
    rows<{ name: string; value: unknown }>(d2, "description").map((r) => [r.name, r.value]),
  );
  const boards = rows<{
    boardid: string; market: string; engine: string; is_traded: number; is_primary: number;
  }>(d2, "boards").filter((b) => b.market === "bonds" && b.engine === "stock");
  const primary = boards.find((b) => b.is_primary === 1) ?? boards[0] ?? null;
  // «Не торгуется» (флаг 6): все режимы с is_traded = 0 — ИЛИ у бумаги вовсе нет режима биржевых торгов
  // облигациями (внебиржевой / коммерческий выпуск): купить-продать через стакан нельзя, данных №1/№4 нет.
  // Раньше такой выпуск проходил как «нет цены» с пустой ликвидностью и получал 90 баллов (08.10.2026).
  const stop = boards.length === 0 || boards.every((b) => b.is_traded === 0);
  const boardid = primary?.boardid ?? null;

  // emitent_title — только в поиске (сверка с живым ISS 08.10.2026)
  let emit: string | null = null;
  let isin = (desc["ISIN"] as string) ?? null;
  let regnumber = (desc["REGNUMBER"] as string) ?? null;
  try {
    const ds = await issJson(q.search(secid), opts);
    const hit = rows<Record<string, unknown>>(ds, "securities").find(
      (r) => r.secid === secid && r.group === "stock_bonds",
    );
    if (hit) {
      emit = (hit.emitent_title as string) ?? null;
      isin = (hit.isin as string) ?? isin;
      regnumber = (hit.regnumber as string) ?? regnumber;
    }
  } catch { /* поиск не критичен для расчётов */ }

  const d1 = boardid ? await issJson(q.n1(boardid, secid), opts) : null;
  const sec = d1 ? rows<Record<string, unknown>>(d1, "securities")[0] ?? {} : {};
  const md = d1 ? rows<Record<string, unknown>>(d1, "marketdata")[0] ?? {} : {};
  const my = d1 ? rows<Record<string, unknown>>(d1, "marketdata_yields")[0] ?? {} : {};
  const dv = d1 ? rows<Record<string, unknown>>(d1, "dataversion")[0] ?? {} : {};
  // Дата расчётов: SETTLEDATE №1 (T+1, в пятницу — понедельник). Без борда или без торгов таблица securities пуста —
  // берём следующий рабочий день после todayIso (праздники не учитываются).
  const settleIso = isoDateOrNull(sec.SETTLEDATE) ?? nextBusinessDay(todayIso);

  const d3 = await issJson(q.n3(secid), opts);
  const couponRows = rows<Record<string, unknown>>(d3, "coupons");
  const amortRows = rows<Record<string, unknown>>(d3, "amortizations");
  const offerRows = rows<Record<string, unknown>>(d3, "offers");

  // №4: окно CONFIG.liq.windowDays календарных дней, последние ≤20 торговых (П13)
  let avg: number | null = null, avgNT: number | null = null, nDays = 0;
  if (boardid && !stop) {
    const from = new Date(Date.parse(todayIso) - CONFIG.liq.windowDays * 86_400_000).toISOString().slice(0, 10);
    const d4 = await issJson(q.n4(boardid, secid, from, todayIso), opts);
    const hist = rows<{ TRADEDATE: string; VALUE: unknown; NUMTRADES: unknown }>(d4, "history");
    const last = hist.slice(-20);
    nDays = last.length;
    if (nDays > 0) {
      avg = last.reduce((s, r) => s + (toNum(r.VALUE) ?? 0), 0) / nDays;
      avgNT = last.reduce((s, r) => s + (toNum(r.NUMTRADES) ?? 0), 0) / nDays;
    } else {
      avg = 0; avgNT = 0;
    }
  }

  // Номинал — на дату расчётов, как и ACCRUEDINT: это пара к фильтру amortFuture `> settleIso` — частичная амортизация
  // в (todayIso, settleIso] уходит продавцу и из потоков покупателя исключена, значит и номинал покупателя — уже без неё
  // (с FACEVALUE цена P и остаток на горизонте были бы завышены на неё в эти 1–3 дня). На всех снимках golden/audit-fixtures
  // поля равны. Для r0 флоатера (ниже) это даёт номинал на дату расчётов, а не на дату последнего купона — точнее брать
  // bondization.valueprc, это WP-A.
  const face = toNum(sec.FACEVALUEONSETTLEDATE) ?? toNum(sec.FACEVALUE);
  const period = toNum(sec.COUPONPERIOD);
  // COUPONPERCENT; если биржа его не отдаёт (бессрочные суборды ВТБ), восстанавливаем из COUPONVALUE × частота / номинал
  let cp = toNum(sec.COUPONPERCENT);
  if (cp == null) {
    const cv = toNum(sec.COUPONVALUE ?? desc["COUPONVALUE"]), fv = face ?? toNum(desc["FACEVALUE"]), fq = toNum(desc["COUPONFREQUENCY"]);
    if (cv != null && fv && fq) cp = Math.round((cv * fq / fv) * 10000) / 100;
  }
  const bondtype = String(sec.BONDTYPE ?? desc["BOND_TYPE"] ?? "");
  const matIso = isoDateOrNull(sec.MATDATE ?? desc["MATDATE"]);
  const bondsubtype = String(sec.BONDSUBTYPE ?? desc["BOND_SUBTYPE"] ?? "");

  // График купонов: сортировка по дате; limit=1000 обязателен — проверено.
  // t и future — от даты расчётов: купон до settleIso покупатель не получит (ISS уже учёл его в ACCRUEDINT)
  const coupons: CouponRow[] = couponRows
    .map((r) => ({
      dateIso: String(r.coupondate),
      value: toNum(r.value),
      valueprc: toNum(r.valueprc),
    }))
    .filter((r) => isoDateOrNull(r.dateIso))
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso))
    .map((r) => ({ ...r, t: yearsFrom(settleIso, r.dateIso), future: r.dateIso > settleIso }));

  // Тип купона (выбор блока формул, 2.3.3.1)
  const bondTypeName = String(desc["BOND_TYPE"] ?? "");
  const structured = String(desc["STRUCTBOND"] ?? "") === "1" || /структурн/i.test(bondTypeName);
  const subordinated = String(desc["SUBORDBOND"] ?? "") === "1";
  const perpetual = /бессрочн/i.test(bondsubtype) || (matIso == null && desc["DAYSTOREDEMPTION"] == null && sec.DAYSTOREDEMPTION == null);
  let ctype: BondFacts["ctype"];
  if (secid.startsWith("SU52")) ctype = "linker";
  else if (/плавающ/i.test(bondtype)) ctype = "float";
  else if (/дисконтн/i.test(bondTypeName)) ctype = "zero";
  // Дисконтная бумага: COUPONPERCENT пуст или 0 и ни одного ненулевого купона в графике
  else if ((cp === null || cp === 0) && coupons.every((c) => !c.value)) ctype = "zero";
  else ctype = "fixed";

  // Текущая ставка флоатера = value последнего выплаченного купона (П9)
  let r0: number | null = null;
  if (ctype === "float" && face && period) {
    const paid = coupons.filter((c) => !c.future && c.value != null);
    const lastPaid = paid[paid.length - 1];
    if (lastPaid?.value != null) r0 = (lastPaid.value / face) * (365 / period) * 100;
  }

  // Амортизация: есть строки data_source='amortization'.
  // Строка на дату погашения (у части выпусков ISS помечает её тоже 'amortization', а не 'maturity') в
  // amortFuture не входит: остаток номинала на погашении считает horizonRed — иначе он удваивался
  // (ПКБ 1Р-12, 09.10.2026: свой расчёт 29,29% против биржевых 18,88%).
  const amortized = amortRows.some((r) => String(r.data_source) === "amortization");
  const amortFuture = amortRows
    .filter(
      (r) =>
        String(r.data_source) === "amortization" &&
        isoDateOrNull(String(r.amortdate)) &&
        String(r.amortdate) > settleIso &&
        String(r.amortdate) !== matIso,
    )
    .map((r) => ({ t: yearsFrom(settleIso, String(r.amortdate)), value: toNum(r.value) ?? 0 }));

  // Оферта (П8): тип — из BONDSUBTYPE и дат опционов, offertype только для показа
  const putDate = isoDateOrNull(sec.PUTOPTIONDATE);
  const callDate = isoDateOrNull(sec.CALLOPTIONDATE);
  let offerKind: BondFacts["offerKind"] = "none";
  if (/\(put\)/i.test(bondsubtype) || putDate) offerKind = "put";
  else if (/\(call\)/i.test(bondsubtype) || callDate) offerKind = "call";

  // Будущие оферты — тоже от даты расчётов: к оферте в день ≤ settleIso покупатель с расчётами T+1 бумагу предъявить не успеет,
  // а горизонт put/call от settleIso дал бы t ≤ 0
  const futureOffers = offerRows
    .map((r) => ({ dateIso: isoDateOrNull(String(r.offerdate)), price: toNum(r.price) }))
    .filter((r) => r.dateIso && r.dateIso > settleIso)
    .sort((a, b) => a.dateIso!.localeCompare(b.dateIso!));
  // Приоритетный источник — PUT/CALLOPTIONDATE из №1: это «ближайшая оферта» самой биржи, к ней она считает доходность
  // (YIELDDATETYPE = OFFER), и фильтром `> settleIso` его намеренно не режем — иначе накануне оферты бумага превращалась бы
  // в «put/call без даты» (тексты F.4), а биржевой main остался бы к оферте. Дата ≤ settleIso здесь — вырожденный горизонт
  // t ≤ 0 (solve → null без диагностики, как и раньше при дате == todayIso); явный статус для него — WP-F.
  const offerDateIso =
    (offerKind === "put" ? putDate : callDate) ?? futureOffers[0]?.dateIso ?? null;
  let offerPrice = toNum(sec.BUYBACKPRICE);
  let offerPriceAssumedPar = false;
  if (offerPrice === null) offerPrice = futureOffers.find((o) => o.dateIso === offerDateIso)?.price ?? null;
  if (offerPrice === null && offerKind !== "none") { offerPrice = 100; offerPriceAssumedPar = true; }

  // Флаг 9: put-оферта, у купонов после неё value и valueprc пусты
  const reset =
    offerKind === "put" && offerDateIso !== null &&
    coupons.some((c) => c.dateIso > offerDateIso && c.value == null && c.valueprc == null);

  const wap = toNum(md.WAPRICE);
  const prevWap = toNum(sec.PREVWAPRICE);

  // Биржевая доходность: пара WAPRICE → EFFECTIVEYIELDWAPRICE (решение вопроса 4, 08.10);
  // до первой сделки дня — PREVWAPRICE → YIELDATPREVWAPRICE из №1 securities.
  // Для флоатеров EFFECTIVEYIELD не используем (2.3.3.1) — на живых данных отдаёт мусор.
  let moexY: number | null = null;
  let moexYPrice: number | null = null;
  let moexYDatetype: string | null = null;
  if (ctype !== "float") {
    moexY = toNum(my.EFFECTIVEYIELDWAPRICE);
    moexYPrice = toNum(my.WAPRICE);
    if (moexY === null) { moexY = toNum(sec.YIELDATPREVWAPRICE); moexYPrice = prevWap; }
    moexYDatetype = (my.YIELDDATETYPE as string) ?? null;
  }

  // НКД: для валютной бумаги ACCRUEDINT (в валюте расчётов) не используем —
  // НКД_ном = COUPONVALUE × дни_с_последнего_купона / COUPONPERIOD (П12); дни — до даты расчётов, как ACCRUEDINT биржи.
  // Рублёвый ACCRUEDINT — биржевой как есть (он уже начислен на SETTLEDATE).
  const fu = String(sec.FACEUNIT ?? desc["FACEUNIT"] ?? "SUR");
  let acc = toNum(sec.ACCRUEDINT);
  if (fu !== "SUR" && fu !== "RUB") {
    const cpv = toNum(sec.COUPONVALUE);
    const nextIso = isoDateOrNull(sec.NEXTCOUPON);
    if (cpv != null && period && nextIso) {
      // Расчёты в день выплаты (NEXTCOUPON ≤ SETTLEDATE): НКД = 0 — купон уходит продавцу и из потоков покупателя
      // уже исключён (future); иначе он был бы учтён дважды: в цене и в недополученном потоке
      const daysToNext = daysBetween(settleIso, nextIso);
      const daysSince = daysToNext <= 0 ? 0 : Math.max(0, period - daysToNext);
      acc = (cpv * daysSince) / period;
    }
  }

  return {
    secid,
    isin,
    boardid,
    shortname: String(desc["SHORTNAME"] ?? sec.SHORTNAME ?? secid),
    secname: (sec.SECNAME as string) ?? (desc["NAME"] as string) ?? null,
    regnumber,
    emit,
    kind: (desc["TYPENAME"] as string) ?? null,
    todayIso,
    settleIso,
    face,
    fu,
    acc,
    cp,
    period,
    matIso,
    daysMat: toNum(desc["DAYSTOREDEMPTION"]),
    nextCouponIso: isoDateOrNull(sec.NEXTCOUPON),
    ctype,
    r0,
    coupons,
    amortFuture,
    amortized,
    offerKind,
    offerDateIso,
    offerPrice,
    offerPriceAssumedPar,
    reset,
    wap,
    prevWap,
    bid: toNum(md.BID),
    offerQ: toNum(md.OFFER),
    upd: (md.UPDATETIME as string) ?? null,
    tradeDateIso: (dv.trade_date as string) ?? null,
    moexY,
    moexYPrice,
    moexYDatetype,
    g: toNum(my.GSPREADBP),
    durDays: toNum(my.DURATION) ?? toNum(md.DURATION),
    stop, structured, subordinated, perpetual,
    lvl: toNum(desc["LISTLEVEL"]),
    qual: toNum(desc["ISQUALIFIEDINVESTORS"]) === 1,
    hasDefault:
      toNum(desc["HASDEFAULT"]) === 1 || toNum(desc["HASTECHNICALDEFAULT"]) === 1,
    avg,
    avgNT,
    nDays,
  };
}
