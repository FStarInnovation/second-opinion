/**
 * Сбор фактов о бумаге: запросы №1–№4 + поиск → нормализованная структура BondFacts.
 * Поля и правила — из раздела «Источники данных» сводной постановки.
 */
import { issJson, rows, toNum, isoDateOrNull, q, type FetchOptions } from "./client";
import { CONFIG } from "../config";

export interface CouponRow {
  dateIso: string;
  t: number; // лет от today
  value: number | null;
  valueprc: number | null;
  future: boolean;
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
  todayIso: string;

  face: number | null; // FACEVALUE №1 (текущий номинал)
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

function yearsFrom(todayIso: string, iso: string): number {
  return (Date.parse(iso) - Date.parse(todayIso)) / 86_400_000 / 365;
}

export async function collectFacts(
  secid: string,
  opts: FetchOptions & { todayIso?: string } = {},
): Promise<BondFacts> {
  const todayIso = opts.todayIso ?? new Date().toISOString().slice(0, 10);

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

  const face = toNum(sec.FACEVALUE);
  const period = toNum(sec.COUPONPERIOD);
  const cp = toNum(sec.COUPONPERCENT);
  const bondtype = String(sec.BONDTYPE ?? desc["BOND_TYPE"] ?? "");
  const bondsubtype = String(sec.BONDSUBTYPE ?? desc["BOND_SUBTYPE"] ?? "");

  // График купонов: сортировка по дате; limit=1000 обязателен — проверено
  const coupons: CouponRow[] = couponRows
    .map((r) => ({
      dateIso: String(r.coupondate),
      value: toNum(r.value),
      valueprc: toNum(r.valueprc),
    }))
    .filter((r) => isoDateOrNull(r.dateIso))
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso))
    .map((r) => ({ ...r, t: yearsFrom(todayIso, r.dateIso), future: r.dateIso > todayIso }));

  // Тип купона (выбор блока формул, 2.3.3.1)
  let ctype: BondFacts["ctype"];
  if (secid.startsWith("SU52")) ctype = "linker";
  else if (/плавающ/i.test(bondtype)) ctype = "float";
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

  // Амортизация: есть строки data_source='amortization'
  const amortized = amortRows.some((r) => String(r.data_source) === "amortization");
  const amortFuture = amortRows
    .filter(
      (r) =>
        String(r.data_source) === "amortization" &&
        isoDateOrNull(String(r.amortdate)) &&
        String(r.amortdate) > todayIso,
    )
    .map((r) => ({ t: yearsFrom(todayIso, String(r.amortdate)), value: toNum(r.value) ?? 0 }));

  // Оферта (П8): тип — из BONDSUBTYPE и дат опционов, offertype только для показа
  const putDate = isoDateOrNull(sec.PUTOPTIONDATE);
  const callDate = isoDateOrNull(sec.CALLOPTIONDATE);
  let offerKind: BondFacts["offerKind"] = "none";
  if (/\(put\)/i.test(bondsubtype) || putDate) offerKind = "put";
  else if (/\(call\)/i.test(bondsubtype) || callDate) offerKind = "call";

  const futureOffers = offerRows
    .map((r) => ({ dateIso: isoDateOrNull(String(r.offerdate)), price: toNum(r.price) }))
    .filter((r) => r.dateIso && r.dateIso > todayIso)
    .sort((a, b) => a.dateIso!.localeCompare(b.dateIso!));
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
  // НКД_ном = COUPONVALUE × дни_с_последнего_купона / COUPONPERIOD (П12)
  const fu = String(sec.FACEUNIT ?? desc["FACEUNIT"] ?? "SUR");
  let acc = toNum(sec.ACCRUEDINT);
  if (fu !== "SUR" && fu !== "RUB") {
    const cpv = toNum(sec.COUPONVALUE);
    const nextIso = isoDateOrNull(sec.NEXTCOUPON);
    if (cpv != null && period && nextIso) {
      const daysToNext = Math.round((Date.parse(nextIso) - Date.parse(todayIso)) / 86_400_000);
      const daysSince = Math.max(0, period - daysToNext);
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
    face,
    fu,
    acc,
    cp,
    period,
    matIso: isoDateOrNull(sec.MATDATE ?? desc["MATDATE"]),
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
    stop,
    lvl: toNum(desc["LISTLEVEL"]),
    qual: toNum(desc["ISQUALIFIEDINVESTORS"]) === 1,
    hasDefault:
      toNum(desc["HASDEFAULT"]) === 1 || toNum(desc["HASTECHNICALDEFAULT"]) === 1,
    avg,
    avgNT,
    nDays,
  };
}
