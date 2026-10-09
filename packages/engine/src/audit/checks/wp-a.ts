/**
 * WP-A — амортизируемые бумаги. Проверки A.1–A.4 по docs/AUDIT_PLAN_2026-10-09.md (раздел WP-A),
 * находки A и E в docs/AUDIT_2026-10-09.md.
 *
 * Каждая проверка утверждает ЖЕЛАЕМОЕ поведение (после правки) — до правки она RED.
 * Эталон везде — независимый IRR по явным потокам (lib.irr), потоки собираются здесь, не в движке:
 *   • купон с value == null — от ОСТАТКА номинала перед датой купона (face − Σ amortFuture[a.t < c.t]), на нулевом остатке = 0;
 *     то же для флоатера: остаток × (r0 + shift(сценарий)) × period/365 (metrics.ts:60 сегодня берёт FACEVALUE),
 *     а сама ставка r0 (facts.ts:186) — от номинала, на который начислен последний выплаченный купон, не от текущего FACEVALUE;
 *   • каждая амортизация до горизонта включительно — один раз (metrics.ts:66 кладёт a.t ≤ tH в потоки,
 *     а horizon()/horizonRed вычитают только a.t < h.t, hc.red колла = полный номинал — выплата в дату оферты/колла удваивается);
 *   • остаток на горизонте = face − Σ amortFuture[a.t ≤ tH], умноженный на цену выкупа (для оферты/колла);
 *   • НДФЛ: с купонов 13 % (первый КУПОН — за вычетом НКД; индекс первого купона — по купонам, не по объединённому массиву
 *     «купоны + амортизации»), с выплат номинала 13 % × max(0, v − v·clean/face).
 * Самопроверка эталона: движок с ЯВНЫМИ значениями купонов (и без спорной амортизации) обязан совпасть с эталоном до 1e-6 —
 * иначе ERROR (дефект харнеса, не продукта). В A.3 харнес дополнительно проверяет различающую силу своей фикстуры:
 * смоделированные частичные правки (мис-индекс НКД, сегодняшняя конвенция) обязаны отстоять от эталона на ≥ 2×допуск — иначе ERROR.
 * База времени: после WP-B t потоков пойдут от SETTLEDATE — харнес берёт базу из фактов (settleIso ?? todayIso),
 * а даты амортизаций ищет с допуском 2/365, чтобы detail не «поплыл».
 * Фикстуры: sfo_ast0, tb9a (секьюритизации с null-купонами), A_float_RU000A109DV5 (ИнтЛиз1Р09 — амортизируемый флоатер,
 * амортизация 40 ₽ в дату каждого купона, снято 09.10.2026).
 */
import fs from "node:fs";
import path from "node:path";
import { collectFacts } from "../../build";
import { CONFIG } from "../../config";
import type { BondFacts, CouponRow } from "../../iss/facts";
import { afterTax, horizon, shift, yieldModel, yieldOf } from "../../metrics";
import {
  FIXTURES_DIR, approx, buildFixture, coupons, expect, facts, fmt, irr, reportOf, snapshotRows, type Check,
} from "../lib";
import type { BondReportT } from "../../contract";

/* ───── локальные помощники (lib их не экспортирует) ───── */
const EPS = 1e-9;
const DAY_TOL = 2 / 365; // допуск при поиске амортизации «в дату»: смена базы времени (WP-B) сдвигает все t одинаково
const yearsFrom = (todayIso: string, iso: string) => (Date.parse(iso) - Date.parse(todayIso)) / 86_400_000 / 365;
const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const dirty = (b: BondFacts, cleanPct: number) => (cleanPct * (b.face ?? 0)) / 100 + (b.acc ?? 0);
/** База отсчёта t в фактах: SETTLEDATE после WP-B, пока — todayIso */
const timeBase = (b: BondFacts) => (b as { settleIso?: string | null }).settleIso ?? b.todayIso;
const delta = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null ? Math.abs(a - b) : null);
const num = (x: unknown): number | null => (x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);

/** Остаток номинала ПЕРЕД выплатами момента t (амортизация в дату купона этот купон не уменьшает — конвенция плана a.t < c.t) */
function remainingBefore(b: BondFacts, t: number): number {
  return Math.max(0, (b.face ?? 0) - sum(b.amortFuture.filter((a) => a.t < t - EPS).map((a) => a.value)));
}
/** Эталонный купон: фикс — опубликованный value, иначе ставка cp от остатка; флоатер — (r0 + shift) от остатка.
 *  base «face» = сегодняшнее поведение движка (ставка от FACEVALUE) — только для иллюстрации в detail. */
function refCoupon(b: BondFacts, c: CouponRow, base: "remaining" | "face", scen: 1 | 2 | 3 = 1): number {
  const nominal = base === "remaining" ? remainingBefore(b, c.t) : (b.face ?? 0);
  if (b.ctype === "float") return (nominal * ((b.r0 ?? 0) + shift(scen, c.t))) / 100 * ((b.period ?? 0) / 365);
  if (c.value != null) return c.value;
  return (nominal * (b.cp ?? 0)) / 100 * ((b.period ?? 0) / 365);
}
interface RefFlows { flows: [number, number][]; coupons: number; amort: number; red: number; nulls: number }
/** Эталонные потоки до горизонта tH включительно: купоны + амортизации (каждая один раз) + остаток после всех амортизаций ≤ tH × redPct/100 */
function refFlows(b: BondFacts, tH: number, redPct = 100, base: "remaining" | "face" = "remaining", scen: 1 | 2 | 3 = 1): RefFlows {
  const flows: [number, number][] = [];
  let cps = 0, am = 0, nulls = 0;
  for (const c of b.coupons) {
    if (!c.future || c.t > tH + EPS) continue;
    if (c.value == null) nulls++;
    const v = refCoupon(b, c, base, scen);
    flows.push([c.t, v]);
    cps += v;
  }
  for (const a of b.amortFuture) if (a.t <= tH + EPS) { flows.push([a.t, a.value]); am += a.value; }
  const red = (Math.max(0, (b.face ?? 0) - am) * redPct) / 100;
  flows.push([tH, red]);
  return { flows, coupons: cps, amort: am, red, nulls };
}
/** Та же бумага как ФИКС с ЯВНЫМИ купонами = эталонным; движок на ней обязан совпасть с эталоном (самопроверка харнеса) */
function withExplicitCoupons(b: BondFacts): BondFacts {
  return { ...b, ctype: "fixed", coupons: b.coupons.map((c) => ({ ...c, value: refCoupon(b, c, "remaining") })) };
}
function selfCheck(label: string, engine: number | null | undefined, ref: number | null): void {
  if (!approx(engine, ref, 1e-6))
    throw new Error(`самопроверка эталона (${label}): движок ${fmt(engine, 6)} ≠ эталон irr ${fmt(ref, 6)} — потоки харнеса не совпадают с потоками движка`);
}

/** Факты и отчёт по снимку харнеса: отчёт — через buildFixture, факты — collectFacts из того же каталога (чтобы вызвать yieldModel напрямую) */
async function fixtureFacts(name: string): Promise<{ b: BondFacts; rep: BondReportT; todayIso: string; dir: string }> {
  const dir = path.join(FIXTURES_DIR, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { query: string; todayIso: string };
  const rep = reportOf(await buildFixture(name));
  const b = await collectFacts(rep.security.secid, { fromSnapshotDir: dir, todayIso: meta.todayIso });
  return { b, rep, todayIso: meta.todayIso, dir };
}

/* ───── общая синтетика: полугодовой купон 12 %, номинал 1000, даты D(i) = today + 182·i ───── */
const TODAY = "2026-10-09";
const CP = 12, PERIOD = 182, FACE = 1000;
const D = (i: number) => addDays(TODAY, PERIOD * i);
const couponOn = (remaining: number) => (remaining * CP) / 100 * (PERIOD / 365);

export const checks: Check[] = [
  /* ───────────────────────── A.1 ───────────────────────── */
  {
    id: "A.1",
    wp: "A",
    kind: "fixture",
    title: "Купон с value=null считается от остатка номинала (на нулевом = 0); флоатер: купон от остатка и ставка r0 от номинала последнего купона (синтетика + ИнтЛиз1Р09 RU000A109DV5)",
    run: async () => {
      const out: string[] = [];
      let ok = true;

      // Вариант 1 — чистый случай: весь номинал гасится в дату 1-го купона, купоны 2–4 (value=null) идут на нулевом остатке.
      {
        const b = facts({
          todayIso: TODAY, matIso: D(4), nextCouponIso: D(1), amortized: true,
          coupons: coupons(TODAY, 4, PERIOD, null),
          amortFuture: [{ t: yearsFrom(TODAY, D(1)), value: FACE }],
        });
        const h = horizon(b);
        const P = dirty(b, 100);
        const ref = refFlows(b, h.t);
        const refY = irr(P, ref.flows);
        selfCheck("A.1 вариант 1", yieldOf(withExplicitCoupons(b), 100, 0, 1, h), refY);
        const own = yieldOf(b, 100, 0, 1, h);
        const phantom = irr(P, refFlows(b, h.t, 100, "face").flows);
        const good = approx(own, refY, 0.02);
        ok &&= good;
        out.push(
          `вариант 1 (фикс, амортизация 1000 ₽ в дату 1-го купона, 3 null-купона на нулевом остатке): yieldOf ${fmt(own)}% vs эталон ${fmt(refY)}% ` +
          `(Δ ${fmt(delta(own, refY))} п.п., допуск 0,02); эталонные потоки: купон ${fmt(couponOn(FACE))} ₽ + 1000 ₽ амортизации, далее 0; ` +
          `вариант «купон от FACEVALUE» (3 × ${fmt(couponOn(FACE))} ₽ фантомных) дал бы ${fmt(phantom)}%`,
        );
      }

      // Вариант 2 — как у СФО-секьюритизаций: 8 null-купонов, амортизация 500 + 500 в даты 2-го и 4-го купонов → купоны 5–8 на нулевом остатке,
      // купоны 3–4 на остатке 500 (купон в дату амортизации считается от остатка ПЕРЕД ней: a.t < c.t).
      {
        const b = facts({
          todayIso: TODAY, matIso: D(8), nextCouponIso: D(1), amortized: true,
          coupons: coupons(TODAY, 8, PERIOD, null),
          amortFuture: [{ t: yearsFrom(TODAY, D(2)), value: 500 }, { t: yearsFrom(TODAY, D(4)), value: 500 }],
        });
        const h = horizon(b);
        const P = dirty(b, 100);
        const ref = refFlows(b, h.t);
        const refY = irr(P, ref.flows);
        selfCheck("A.1 вариант 2", yieldOf(withExplicitCoupons(b), 100, 0, 1, h), refY);
        const own = yieldOf(b, 100, 0, 1, h);
        const phantom = irr(P, refFlows(b, h.t, 100, "face").flows);
        const good = approx(own, refY, 0.02);
        ok &&= good;
        out.push(
          `вариант 2 (фикс, 500 ₽ + 500 ₽ в даты 2-го и 4-го купонов, 8 null-купонов): yieldOf ${fmt(own)}% vs эталон ${fmt(refY)}% ` +
          `(Δ ${fmt(delta(own, refY))} п.п.); эталонные купоны: 2 × ${fmt(couponOn(1000))}, 2 × ${fmt(couponOn(500))}, 4 × 0,00 ₽, остаток к погашению ${fmt(ref.red)} ₽; ` +
          `вариант «купон от FACEVALUE» (8 × ${fmt(couponOn(FACE))} ₽) дал бы ${fmt(phantom)}%`,
        );
      }

      // Вариант 3 — флоатер (metrics.ts:60): ставка r0 = 12 %, 4 null-купона, амортизация 500 ₽ в дату 2-го купона → купоны 3–4 от остатка 500.
      // Проверяются все три сценария ставки (shift из движка — он не предмет проверки); main флоатера = сценарий 1.
      {
        const b = facts({
          todayIso: TODAY, matIso: D(4), nextCouponIso: D(1), amortized: true,
          ctype: "float", r0: CP,
          coupons: coupons(TODAY, 4, PERIOD, null),
          amortFuture: [{ t: yearsFrom(TODAY, D(2)), value: 500 }],
        });
        const h = horizon(b);
        const P = dirty(b, 100);
        const ref = refFlows(b, h.t);
        const refY = irr(P, ref.flows);
        selfCheck("A.1 вариант 3 (флоатер как фикс с явными купонами)", yieldOf(withExplicitCoupons(b), 100, 0, 1, h), refY);
        const own = yieldOf(b, 100, 0, 1, h);
        const m = yieldModel(b, {});
        const phantom = irr(P, refFlows(b, h.t, 100, "face").flows);
        const scen = ([2, 3] as const).map((s) => ({
          s, eng: yieldOf(b, 100, 0, s, h), ref: irr(P, refFlows(b, h.t, 100, "remaining", s).flows),
        }));
        const good = approx(own, refY, 0.02) && scen.every((x) => approx(x.eng, x.ref, 0.02));
        ok &&= good;
        out.push(
          `вариант 3 (флоатер r0 ${CP} %, 4 null-купона, амортизация 500 ₽ в дату 2-го купона): yieldOf сц.1 ${fmt(own)}% vs эталон ${fmt(refY)}% ` +
          `(Δ ${fmt(delta(own, refY))} п.п., допуск 0,02), yieldModel.main ${fmt(m.main)}% (status ${m.status}); ` +
          scen.map((x) => `сц.${x.s} ${fmt(x.eng)}% vs ${fmt(x.ref)}%`).join(", ") + "; " +
          `эталонные купоны сц.1: 2 × ${fmt(couponOn(1000))} + 2 × ${fmt(couponOn(500))} ₽, остаток к погашению ${fmt(ref.red)} ₽; ` +
          `вариант «FACEVALUE × r0» (4 × ${fmt(couponOn(FACE))} ₽) даёт ${fmt(phantom)}%`,
        );
      }

      // Вариант 4 — живой снимок: ИнтЛиз1Р09 (RU000A109DV5), флоатер с амортизацией 40 ₽ в дату КАЖДОГО купона.
      // (а) r0 (facts.ts:186): последний выплаченный купон начислен на номинал ДО амортизации того же дня (FACEVALUE + 40),
      //     движок делит на текущий FACEVALUE → ставка завышена; эталон — опубликованная ISS ставка купона (valueprc), допуск 0,1 п.п.
      // (б) main (сценарий 1 = плоская ставка r0): эталон — IRR с купонами «остаток × ставка эталона», амортизации один раз, остаток к погашению; допуск 0,1 п.п.
      {
        const { b, rep, todayIso, dir } = await fixtureFacts("A_float_RU000A109DV5");
        if (b.ctype !== "float" || !b.amortized) throw new Error(`фикстура A_float_RU000A109DV5: ожидался амортизируемый флоатер (ctype=${b.ctype}, amortized=${b.amortized})`);
        const cRows = snapshotRows(dir, "bondization", "coupons").filter((r) => String(r.coupondate) <= todayIso && num(r.value) != null)
          .sort((x, y) => String(x.coupondate).localeCompare(String(y.coupondate)));
        const lp = cRows[cRows.length - 1];
        if (!lp) throw new Error("фикстура A_float_RU000A109DV5: нет выплаченных купонов в снимке");
        const lpDate = String(lp.coupondate), lpValue = num(lp.value)!, lpPrc = num(lp.valueprc);
        const lpDays = Math.round((Date.parse(lpDate) - Date.parse(String(lp.startdate))) / 86_400_000);
        const amortSince = sum(snapshotRows(dir, "bondization", "amortizations")
          .filter((r) => String(r.data_source) === "amortization" && String(r.amortdate) >= lpDate && String(r.amortdate) <= todayIso)
          .map((r) => num(r.value) ?? 0));
        const nominalBefore = (b.face ?? 0) + amortSince;
        const r0Formula = (lpValue / nominalBefore) * (365 / (b.period ?? lpDays)) * 100;
        const r0Ref = lpPrc ?? r0Formula;
        const goodR0 = approx(b.r0, r0Ref, 0.1);

        const h = horizon(b);
        const m = yieldModel(b, {});
        if (m.P == null) throw new Error(`yieldModel: нет цены (status=${m.status})`);
        const bRef: BondFacts = { ...b, r0: r0Ref };
        const ref = refFlows(bRef, h.t);
        const refY = irr(m.P, ref.flows);
        const onlyRate = irr(m.P, refFlows(b, h.t).flows); // остаток × r0 движка — вклад одной лишь ставки
        const phantom = irr(m.P, refFlows(b, h.t, 100, "face").flows); // FACEVALUE × r0 движка = сегодняшний main
        const goodY = approx(m.main, refY, 0.1);
        ok &&= goodR0 && goodY;
        const sec = snapshotRows(dir, "engines_stock", "securities")[0] ?? {};
        const nextPublished = b.coupons.find((c) => c.future);
        out.push(
          `вариант 4 ИнтЛиз1Р09 (${b.secid}, ${rep.security.shortname}; FACEVALUE ${b.face}, COUPONPERIOD ${b.period}, будущих амортизаций ${b.amortFuture.length} на ${fmt(sum(b.amortFuture.map((a) => a.value)))} ₽, остаток к погашению ${fmt(ref.red)} ₽): ` +
          `r0 ${fmt(b.r0)}% vs ставка последнего выплаченного купона ${fmt(r0Ref)}% (Δ ${fmt(delta(b.r0, r0Ref))} п.п., допуск 0,1; ` +
          `купон ${lpDate} = ${fmt(lpValue)} ₽ за ${lpDays} дн. при valueprc ${fmt(lpPrc)}, начислен на номинал ${fmt(nominalBefore)} = FACEVALUE + ${fmt(amortSince)} ₽ амортизации того же дня: ${fmt(lpValue)}/${fmt(nominalBefore)}×365/${b.period} = ${fmt(r0Formula)}%; ` +
          `движок делит на FACEVALUE ${b.face} → ${fmt(b.r0)}%); ` +
          `yieldModel.main ${fmt(m.main)}% vs эталон ${fmt(refY)}% (Δ ${fmt(delta(m.main, refY))} п.п., допуск 0,1; ставка ${fmt(r0Ref)} от остатка, P ${fmt(m.P)} ₽, горизонт «${h.label}»); ` +
          `разложение: остаток × r0 движка даёт ${fmt(onlyRate)}%, FACEVALUE × r0 движка — ${fmt(phantom)}% (= main); ` +
          `ISS уже опубликовал следующий купон ${nextPublished?.dateIso ?? "—"}: ${fmt(nextPublished?.value)} ₽ при ${fmt(nextPublished?.valueprc)}% — движок для флоатера его игнорирует; биржевая YIELDATPREVWAPRICE ${fmt(num(sec.YIELDATPREVWAPRICE))}% (для флоатеров движком не используется), own_control_pct отчёта ${fmt(rep.yield.own_control_pct)}`,
        );
      }
      return expect(ok, out.join(" | "));
    },
  },

  /* ───────────────────────── A.2 ───────────────────────── */
  {
    id: "A.2",
    wp: "A",
    kind: "fixture",
    title: "Секьюритизации с null-купонами (ССекьюр_А RU000A10AST0, ТБ-9_А RU000A10FWR5): |own_control − биржа| ≤ 1 п.п.",
    run: async () => {
      const out: string[] = [];
      let ok = true;
      for (const name of ["sfo_ast0", "tb9a"]) {
        const { b, rep, todayIso, dir } = await fixtureFacts(name);
        const own = rep.yield.own_control_pct, ex = rep.yield.exchange.pct;
        const d = delta(own, ex);
        const good = d != null && d <= 1;
        ok &&= good;

        // Независимый эталон: от цены биржи (moexYPrice), купон от остатка, к горизонту движка; t как в фактах (база timeBase)
        // и — пока база = todayIso — дополнительно от SETTLEDATE (конвенция ISS, WP-B)
        const h = horizon(b);
        const price = b.moexYPrice ?? b.wap ?? b.prevWap ?? 0;
        const ref = refFlows(b, h.t);
        const refBase = irr(dirty(b, price), ref.flows);
        const sec = snapshotRows(dir, "engines_stock", "securities")[0] ?? {};
        const settle = typeof sec.SETTLEDATE === "string" ? sec.SETTLEDATE : null;
        const base = timeBase(b);
        const shiftY = settle && base === todayIso && settle !== todayIso ? yearsFrom(todayIso, settle) : 0;
        const refSettle = shiftY ? irr(dirty(b, price), ref.flows.map(([t, cf]) => [t - shiftY, cf] as [number, number])) : null;
        const phantom = irr(dirty(b, price), refFlows(b, h.t, 100, "face").flows);
        const futureNulls = b.coupons.filter((c) => c.future && c.value == null).length;

        out.push(
          `${name} (${b.shortname}): own_control_pct ${fmt(own)} vs exchange.pct ${fmt(ex)} (${rep.yield.exchange.datetype ?? "—"}, цена ${fmt(b.moexYPrice)}%) → Δ ${fmt(d)} п.п. ${good ? "≤" : ">"} 1, control_diff_pp ${fmt(rep.yield.control_diff_pp)}; ` +
          `FACEVALUE ${b.face}, будущих амортизаций ${b.amortFuture.length} на ${fmt(sum(b.amortFuture.map((a) => a.value)))} ₽ (остаток на горизонте «${h.label}» ${fmt(ref.red)} ₽), null-купонов ${futureNulls} (${ref.nulls} до горизонта), ` +
          `фантомный купон от FACEVALUE ${fmt(couponFromFace(b))} ₽; эталон (купон от остатка): ${fmt(refBase)}% при t от ${base}` +
          (refSettle != null ? `, ${fmt(refSettle)}% при t от SETTLEDATE ${settle}` : "") + `; ` +
          `вариант «купон от FACEVALUE» воспроизводит ${fmt(phantom)}%`,
        );
      }
      return expect(ok, out.join(" | "));
    },
  },

  /* ───────────────────────── A.3 ───────────────────────── */
  {
    id: "A.3",
    wp: "A",
    kind: "unit",
    title: "Постналоговая доходность амортизируемой бумаги: НДФЛ с купонов отдельно от номинала, амортизация облагается как номинал, вычет НКД — у первого КУПОНА, а не у первой выплаты объединённого массива (эталон ±0,1 п.п., две раскладки дат амортизаций)",
    run: () => {
      // Номинал 1000, цена 95 %. Первый купон через 45 дней: прошло 137 из 182 дней периода → НКД 45,04 ₽ (реальная величина для такой
      // точки периода, а не «20 ₽ при полном периоде впереди»). Амортизация 250 ₽ × 3, остаток 250 ₽ гасится на 4-м купоне (погашение).
      // Купоны начислены на остаток номинала на НАЧАЛО купонного периода (конвенция ISS) и заданы явно — амортизация внутри периода их не меняет.
      // Две раскладки дат амортизаций — обе обязаны пройти:
      //   «в дату купона» — как у реальных бумаг (ИнтЛиз1Р09, СФО); при равных t порядок элементов в объединённом массиве решает tie-break сортировки;
      //   «первая амортизация за 15 дней ДО первого купона» — любая правка, ищущая «первую выплату» по объединённому массиву, отсортированному
      //   по дате, отдаст вычет НКД выплате номинала независимо от tie-break (а при сегодняшнем порядке couponFlows «купоны, затем амортизации»
      //   индекс 0 — купон, поэтому обе раскладки RED сегодня только по налогу на номинал).
      // Величина НКД выбрана так, чтобы мис-индекс сдвигал IRR на ≥ 0,6 п.п.: при НКД 20 ₽ сдвиг был 0,09 < допуска 0,1 (замечание раунда 3).
      // Сам допуск 0,1 — из плана (приёмка A.3) и не ужесточается: различающую силу даёт фикстура, и харнес проверяет её сам (ERROR, если
      // смоделированная частичная правка укладывается в 2×допуск).
      const TOL = 0.1;
      const OFF = 45, cleanPct = 95;
      const C = (i: number) => addDays(TODAY, OFF + PERIOD * i);
      const acc = Math.round(couponOn(FACE) * ((PERIOD - OFF) / PERIOD) * 100) / 100; // НКД за 137 из 182 дней = 45,04 ₽
      const remaining = [1000, 750, 500, 250];
      const clean = (cleanPct * FACE) / 100;
      const T = CONFIG.tax;
      // Эталон: купоны — 13 % (первый КУПОН за вычетом НКД); номинал (амортизации и остаток) — 13 % × max(0, v − v·clean/face)
      const taxCoupon = (v: number, first: boolean) => T * Math.max(0, v - (first ? acc : 0));
      const taxPrincipal = (v: number) => T * Math.max(0, v - (v * clean) / FACE);

      const variants = [
        { label: "амортизация в дату купона", amortIso: [C(0), C(1), C(2)] },
        { label: "первая амортизация за 15 дней ДО первого купона", amortIso: [addDays(C(0), -15), C(1), C(2)] },
      ];
      const out: string[] = [];
      let ok = true;
      for (const v of variants) {
        const b = facts({
          todayIso: TODAY, matIso: C(3), nextCouponIso: C(0), acc, amortized: true,
          coupons: coupons(TODAY, 4, PERIOD, (i) => couponOn(remaining[i]), OFF),
          amortFuture: v.amortIso.map((iso) => ({ t: yearsFrom(TODAY, iso), value: 250 })),
        });
        const h = horizon(b);
        const P = dirty(b, cleanPct);

        // Самопроверка: до налога движок = эталон (потоки совпадают)
        const ref = refFlows(b, h.t);
        const preRef = irr(P, ref.flows);
        const pre = yieldOf(b, cleanPct, 0, 1, h);
        selfCheck(`A.3 до налога (${v.label})`, pre, preRef);

        const cps = b.coupons.filter((c) => c.future && c.t <= h.t + EPS);
        const ams = b.amortFuture.filter((a) => a.t <= h.t + EPS);
        const redPost: [number, number] = [h.t, ref.red - taxPrincipal(ref.red)];
        const post: [number, number][] = [
          ...cps.map((c, i): [number, number] => [c.t, c.value! - taxCoupon(c.value!, i === 0)]),
          ...ams.map((a): [number, number] => [a.t, a.value - taxPrincipal(a.value)]),
          redPost,
        ];
        const postRef = irr(P, post);

        // Модели частичной правки (только для detail и проверки различающей силы фикстуры): налог на номинал исправлен, но «первая выплата»
        // ищется по объединённому массиву «купоны + амортизации», отсортированному по t (при равных t амортизация первой — худший tie-break):
        //   M1 — вычет НКД достаётся элементу 0, чем бы он ни был (из его налоговой базы);
        //   M2 — вычет только в ветке купона, но индекс общий → первый купон (элемент 1) остаётся без вычета.
        const merged = [
          ...cps.map((c) => ({ t: c.t, v: c.value!, coupon: true })),
          ...ams.map((a) => ({ t: a.t, v: a.value, coupon: false })),
        ].sort((x, y) => x.t - y.t || (x.coupon ? 1 : -1));
        const m1 = irr(P, [
          ...merged.map((x, i): [number, number] => [x.t, x.v - T * Math.max(0, (x.coupon ? x.v : x.v - (x.v * clean) / FACE) - (i === 0 ? acc : 0))]),
          redPost,
        ]);
        const m2 = irr(P, [
          ...merged.map((x, i): [number, number] => [x.t, x.v - (x.coupon ? taxCoupon(x.v, i === 0) : taxPrincipal(x.v))]),
          redPost,
        ]);
        // Сегодняшняя конвенция движка (для detail): амортизация облагается как купон, «убыток» на погашении возвращает налог
        const gainLegacy = ref.red - clean;
        const legacy = irr(P, [
          ...cps.map((c, i): [number, number] => [c.t, c.value! - taxCoupon(c.value!, i === 0)]),
          ...ams.map((a): [number, number] => [a.t, a.value - T * a.value]),
          [h.t, ref.red - T * Math.max(0, gainLegacy) + (gainLegacy < 0 ? T * -gainLegacy : 0)],
        ]);
        // Различающая сила фикстуры — дефект харнеса (ERROR), если какая-то из смоделированных неполных правок укладывается в 2×допуск
        for (const [name, y] of [["мис-индекс M1", m1], ["мис-индекс M2", m2], ["сегодняшняя конвенция", legacy]] as const) {
          const d = delta(postRef, y);
          if (d == null || d < 2 * TOL)
            throw new Error(`A.3 (${v.label}): фикстура не различает «${name}» и эталон (Δ ${fmt(d)} п.п. < 2×допуск ${2 * TOL}) — усилить НКД или даты амортизаций`);
        }

        const postEngine = afterTax(b, cleanPct, 0, 1, h);
        const good = approx(postEngine, postRef, TOL);
        ok &&= good;
        const c1 = cps[0]!.value!;
        out.push(
          `${v.label}: afterTax ${fmt(postEngine)}% vs эталон ${fmt(postRef)}% (Δ ${fmt(delta(postEngine, postRef))} п.п., допуск ${TOL}); до налога ${fmt(pre)}% = эталон ${fmt(preRef)}%; ` +
          `P ${fmt(P)} ₽ (${cleanPct} % + НКД ${fmt(acc)}), купоны ${remaining.map((r) => fmt(couponOn(r))).join("/")} ₽ в ${cps.map((c) => c.dateIso).join("/")}, ` +
          `амортизации 3 × 250 ₽ в ${v.amortIso.join("/")} + остаток ${fmt(ref.red)} ₽ на погашении ${h.dateIso ?? "—"}; ` +
          `налог с 1-го купона по эталону ${fmt(taxCoupon(c1, true))} ₽ (13 % × (${fmt(c1)} − НКД ${fmt(acc)})), без вычета НКД был бы ${fmt(taxCoupon(c1, false))} ₽; ` +
          `налог с 1-й амортизации 250 ₽ по эталону ${fmt(taxPrincipal(250))} ₽ (13 % × (250 − 250 × 0,95)), «как с купона» ${fmt(T * 250)} ₽; ` +
          `различающая сила фикстуры: вычет НКД по объединённому массиву даёт ${fmt(m1)}% (вычет у выплаты номинала, Δ ${fmt(delta(postRef, m1))}) ` +
          `или ${fmt(m2)}% (вычет потерян, Δ ${fmt(delta(postRef, m2))}); сегодняшняя конвенция (амортизация как купон, возврат «убытком» на погашении) ${fmt(legacy)}% (Δ ${fmt(delta(postRef, legacy))})`,
        );
      }
      return expect(ok, out.join(" | "));
    },
  },

  /* ───────────────────────── A.4 ───────────────────────── */
  {
    id: "A.4",
    wp: "A",
    kind: "fixture",
    title: "Амортизация в дату колла/оферты учтена один раз, остаток на колле × цена выкупа: call.y и own = эталонный IRR, recv = купоны + остаток (синтетика call/put + RU000A10AST0)",
    run: async () => {
      const out: string[] = [];
      let ok = true;
      // Выкуп по 100 % в случаях «амортизация в дату колла/оферты» — чтобы утверждение не зависело от того, какой из двух допускаемых планом
      // вариантов границы выберет правка (вычесть a.t ≤ h.t из остатка или не класть a.t ≥ tH в потоки): при паре они дают одинаковые потоки.
      const remaining = [1000, 800, 500, 500];
      const mk = (over: Partial<BondFacts>) => facts({
        todayIso: TODAY, matIso: D(4), nextCouponIso: D(1), amortized: true,
        coupons: coupons(TODAY, 4, PERIOD, (i) => couponOn(remaining[i])),
        amortFuture: [{ t: yearsFrom(TODAY, D(1)), value: 200 }, { t: yearsFrom(TODAY, D(2)), value: 300 }],
        offerDateIso: D(2), offerPrice: 100,
        ...over,
      });

      // Самопроверка эталона: колл-бумага БЕЗ амортизации, выкуп по 100 % → движок обязан совпасть с эталоном
      {
        const b0 = mk({ offerKind: "call", amortized: false, amortFuture: [], coupons: coupons(TODAY, 4, PERIOD, couponOn(FACE)) });
        const m0 = yieldModel(b0, {});
        if (!m0.call || m0.P == null) throw new Error(`yieldModel не построил ветку call на бумаге без амортизации: status=${m0.status}`);
        selfCheck("A.4 call без амортизации", m0.call.y, irr(m0.P, refFlows(b0, yearsFrom(timeBase(b0), D(2)), 100).flows));
      }

      // Синтетика CALL: колл в дату 2-го купона (364 дня, не «скорый»), амортизация 200 ₽ в 1-й купон и 300 ₽ РОВНО в дату колла, выкуп по 100 %.
      {
        const b = mk({ offerKind: "call" });
        const m = yieldModel(b, {});
        if (!m.call || m.P == null) throw new Error(`yieldModel не построил ветку call: status=${m.status}, call=${JSON.stringify(m.call)}`);
        const tC = yearsFrom(timeBase(b), D(2));
        const ref = refFlows(b, tC, b.offerPrice ?? 100);
        const refY = irr(m.P, ref.flows);
        const refRecv = ref.coupons + ref.amort + ref.red;
        const recv = m.call.gain + m.P;
        const goodY = approx(m.call.y, refY, 0.02), goodRecv = approx(recv, refRecv, 0.01);
        ok &&= goodY && goodRecv;
        out.push(
          `call (амортизация 300 ₽ в дату колла, выкуп 100 %): call.y ${fmt(m.call.y)}% vs эталон ${fmt(refY)}% (Δ ${fmt(delta(m.call.y, refY))} п.п., допуск 0,02); ` +
          `recv = gain + P = ${fmt(recv)} ₽ vs эталон ${fmt(refRecv)} ₽ (купоны ${fmt(ref.coupons)} + амортизации ${fmt(ref.amort)} + остаток ${fmt(ref.red)} × 100 %); ` +
          (Math.abs(recv - refRecv) > 0.005
            ? `превышение ${fmt(recv - refRecv)} ₽ = амортизация ${fmt(ref.amort)} ₽ учтена второй раз (в потоках couponFlows и в hc.red = номинал ${FACE} вместо остатка ${fmt(ref.red)}); `
            : "амортизация учтена один раз; ") +
          `days ${m.call.days}, short=${m.call.short}, main ${fmt(m.main)}%`,
        );
      }

      // Синтетика CALL с премией: выкуп по 101 %, амортизация 200 ₽ только в 1-й купон (ДО колла — границы не касается) →
      // остаток на колле 800 × 101 % = 808 ₽ и в call.y, и в recv (план: hc.red = остаток × offerPrice; recv по тем же потокам, что yieldOf).
      {
        const b = mk({ offerKind: "call", offerPrice: 101, amortFuture: [{ t: yearsFrom(TODAY, D(1)), value: 200 }] });
        const m = yieldModel(b, {});
        if (!m.call || m.P == null) throw new Error(`yieldModel не построил ветку call (премия): status=${m.status}`);
        const tC = yearsFrom(timeBase(b), D(2));
        const ref = refFlows(b, tC, 101);
        const refY = irr(m.P, ref.flows);
        const refRecv = ref.coupons + ref.amort + ref.red;
        const recv = m.call.gain + m.P;
        const parY = irr(m.P, refFlows(b, tC, 100).flows); // как если бы премии не было
        const goodY = approx(m.call.y, refY, 0.02), goodRecv = approx(recv, refRecv, 0.01);
        ok &&= goodY && goodRecv;
        out.push(
          `call с премией (выкуп 101 %, амортизация 200 ₽ до колла): call.y ${fmt(m.call.y)}% vs эталон ${fmt(refY)}% (Δ ${fmt(delta(m.call.y, refY))} п.п.; без премии было бы ${fmt(parY)}%); ` +
          `recv ${fmt(recv)} ₽ vs эталон ${fmt(refRecv)} ₽ (купоны ${fmt(ref.coupons)} + амортизация 200 + остаток 800 × 101 % = ${fmt(ref.red)})` +
          (Math.abs(recv - refRecv) > 0.005 || !goodY
            ? `; recv считает hc.red = ${FACE} × 1,01 = ${fmt(FACE * 1.01)} ₽ (номинал без вычета амортизации), а yieldOf через horizonRed для kind «call» берёт ${FACE} − 200 = 800 ₽ без премии: сумма и доходность — по разным потокам`
            : ""),
        );
      }

      // Синтетика PUT (horizon(), metrics.ts:48): оферта в дату 2-го купона по 100 %, амортизация 200 ₽ в 1-й купон и 300 ₽ РОВНО в дату оферты.
      {
        // Самопроверка эталона: амортизация только ДО оферты → движок обязан совпасть с эталоном
        const b0 = mk({ offerKind: "put", amortFuture: [{ t: yearsFrom(TODAY, D(1)), value: 200 }] });
        const h0 = horizon(b0);
        const m0 = yieldModel(b0, {});
        if (h0.kind !== "offer" || m0.P == null) throw new Error(`horizon() не дал горизонт оферты для put: kind=${h0.kind}, status=${m0.status}`);
        selfCheck("A.4 put без амортизации в дату оферты", m0.own, irr(m0.P, refFlows(b0, h0.t, b0.offerPrice ?? 100).flows));

        const b = mk({ offerKind: "put" });
        const h = horizon(b);
        const m = yieldModel(b, {});
        if (h.kind !== "offer" || m.P == null) throw new Error(`horizon() не дал горизонт оферты для put: kind=${h.kind}, status=${m.status}`);
        const ref = refFlows(b, h.t, b.offerPrice ?? 100);
        const refY = irr(m.P, ref.flows);
        const good = approx(m.own, refY, 0.02);
        ok &&= good;
        const atOffer = b.amortFuture.filter((a) => Math.abs(a.t - h.t) < DAY_TOL).map((a) => a.value);
        out.push(
          `put (амортизация 300 ₽ в дату оферты, выкуп 100 %): own ${fmt(m.own)}% vs эталон ${fmt(refY)}% (Δ ${fmt(delta(m.own, refY))} п.п., допуск 0,02), main ${fmt(m.main)}%; ` +
          `horizon() «${h.label}» red ${fmt(h.red)} ₽ при остатке после всех амортизаций ≤ оферты ${fmt(ref.red)} ₽ × 100 %` +
          (h.red - ref.red > 0.005
            ? ` — амортизация ${atOffer.map((v) => fmt(v)).join("+")} ₽ в дату оферты не вычтена из остатка (a.t < t), но лежит в потоках couponFlows (a.t ≤ tH): учтена дважды, +${fmt(h.red - ref.red)} ₽`
            : " — амортизация в дату оферты учтена один раз"),
        );
      }

      // Фикстура: ССекьюр_А — колл 25.01.2028 совпадает с последней амортизацией (99 ₽), к этой дате остаток = 0; у биржи YIELDDATETYPE=OFFER.
      {
        const { b } = await fixtureFacts("sfo_ast0");
        const m = yieldModel(b, {});
        if (b.offerKind !== "call" || !b.offerDateIso || !m.call || m.P == null)
          throw new Error(`фикстура sfo_ast0: ожидалась колл-бумага с датой колла и веткой call (offerKind=${b.offerKind}, offerDateIso=${b.offerDateIso}, status=${m.status})`);
        const tC = yearsFrom(timeBase(b), b.offerDateIso);
        const ref = refFlows(b, tC, b.offerPrice ?? 100);
        const refY = irr(m.P, ref.flows);
        const refRecv = ref.coupons + ref.amort + ref.red;
        const recv = m.call.gain + m.P;
        const amortAtCall = b.amortFuture.filter((a) => Math.abs(a.t - tC) < DAY_TOL).map((a) => a.value);
        const goodY = approx(m.call.y, refY, 0.05), goodRecv = approx(recv, refRecv, 0.01);
        ok &&= goodY && goodRecv;
        out.push(
          `sfo_ast0 (${b.shortname}, колл ${b.offerDateIso} по ${fmt(b.offerPrice)}%, амортизация в дату колла ${amortAtCall.map((v) => fmt(v)).join("+") || "нет"} ₽, t от ${timeBase(b)}): ` +
          `call.y ${fmt(m.call.y)}% vs эталон ${fmt(refY)}% (Δ ${fmt(delta(m.call.y, refY))} п.п., допуск 0,05; биржа к OFFER ${fmt(b.moexY)}%); ` +
          `recv ${fmt(recv)} ₽ vs эталон ${fmt(refRecv)} ₽ (купоны ${fmt(ref.coupons)} + амортизации ${fmt(ref.amort)} + остаток ${fmt(ref.red)}), превышение ${fmt(recv - refRecv)} ₽ при FACEVALUE ${b.face}; P ${fmt(m.P)} ₽, main ${fmt(m.main)}%`,
        );
      }
      return expect(ok, out.join(" | "));
    },
  },
];

/** Купон, который движок сегодня подставляет вместо null: FACEVALUE × COUPONPERCENT × COUPONPERIOD/365 */
function couponFromFace(b: BondFacts): number {
  return ((b.face ?? 0) * (b.cp ?? 0)) / 100 * ((b.period ?? 0) / 365);
}
