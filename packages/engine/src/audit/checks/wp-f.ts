/**
 * WP-F — горизонт «колл». Проверки по docs/AUDIT_PLAN_2026-10-09.md (раздел WP-F) и AUDIT_2026-10-09.md (P1 §F).
 * Каждая утверждает ЖЕЛАЕМОЕ поведение; до правки — RED.
 *
 * Суть дефекта: horizon() знает только maturity|offer(put). Для колл-бумаги биржа считает EFFECTIVEYIELDWAPRICE
 * к дате колла (YIELDDATETYPE=OFFER), движок берёт число (или заменяет его call.y через min — yield-to-worst),
 * но подписывает «к погашению MATDATE», а контроль own↔биржа сравнивает разные горизонты.
 * Число менять НЕ надо (yield-to-worst прав) — меняются горизонт/подписи и горизонт контроля.
 *
 * Два правила плана, по которым горизонт отчёта должен стать «call»:
 *   (1) биржа считает к коллу: moexYDatetype==="OFFER" и offerKind==="call" (main = moexY, замены нет);
 *   (2) main заменён call.y через min(main, call.y).
 * Фикстура call_telhol удовлетворяет обоим одновременно (OFFER и 16.88 < 17.22), поэтому правило (1) изолировано
 * синтетикой F.2(в), а правило (2) — F.2(а); F.2(г) защищает от реализации «любая биржевая доходность у колл-бумаги → call».
 *
 * Подписи блока yield утверждаются ПОЗИТИВНО (точные строки плана: «к коллу DD.MM.YYYY», «удержании до колла DD.MM.YYYY»,
 * horizon_label «колла DD.MM.YYYY» — формат hc.label уже есть в metrics.ts), а не «без „погашени“»: иначе проходила бы
 * и «к колла …» (report.ts:88 заменяет только ^погашения/^оферты), и «к оферте …».
 *
 * Горизонт — ОДИН на отчёт (план: меняется сам horizon(); report.ts:33 `h = ym.h ?? horizon(b)` питает kGrid/afterTax,
 * worst «Рост ставок» берёт horizon_label). Поэтому F.1/F.2 сверяют не только блок yield, но и производные блоки:
 *   - fees_tax.k_grid[k=0].pre обязан равняться own-доходности к горизонту main (к коллу — yieldModel().call.y,
 *     к погашению — yieldModel().own); сравнение округлённых до 0,01 без допуска — это один и тот же yieldOf
 *     от той же цены к тому же горизонту;
 *   - worst «Рост ставок».text обязан нести ДАТУ горизонта main (DD.MM.YYYY); формулировка вокруг даты не оценивается
 *     («держать до колла 25.03.2027», «до даты колла (25.03.2027)» — равнозначны), упоминание даты другого горизонта
 *     печатается справочно и вердикт не меняет (план такого запрета не задаёт).
 * Правка «только подписи yield» без общего горизонта остаётся RED (принцип 2 плана «одна величина — одно значение»).
 * Сверка — продукт с продуктом (k_grid против yieldModel().call.y/own той же сборки), независимого пересчёта к коллу
 * здесь нет; независимый IRR к коллу есть в F.3.
 *
 * Устойчивость к форме правки: предусловия синтетики F.2 сравнивают call.y движка с YTM по горизонту погашения, который
 * строит сам харнес (не yieldModel().own) — после правки движок вправе переопределить own как «доходность к горизонту h»,
 * и предусловие не должно от этого падать в ERROR. По той же причине предусловия фикстуры не требуют exchange.used_as_main
 * (после замены числа через min реализация вправе снять этот флаг) — требуются только OFFER-датотип, колл и наличие
 * биржевого числа в рублёвой бумаге.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../../config";
import { collectFacts, dmy, type BondFacts } from "../../iss/facts";
import { afterTax, horizon, yieldModel, yieldOf, type Horizon } from "../../metrics";
import { assembleReport } from "../../report";
import type { BondReportT } from "../../contract";
import { FIXTURES_DIR, buildFixture, coupons, expect, facts, fmt, irr, reportOf, snapshotRows, type Check } from "../lib";

/* ───── локальные помощники (lib.ts не трогаем) ───── */

/** BondFacts из снимка фикстуры — чтобы вызывать horizon()/yieldModel() напрямую (buildFixture отдаёт только отчёт). */
async function fixtureFacts(name: string): Promise<BondFacts> {
  const dir = path.join(FIXTURES_DIR, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { query: string; todayIso: string };
  return collectFacts(meta.query, { fromSnapshotDir: dir, todayIso: meta.todayIso });
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const yearsBetween = (fromIso: string, toIso: string) => (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000 / 365;
const q = (s: string | null | undefined, n = 90) => (s == null ? "null" : `«${s.length > n ? s.slice(0, n - 1) + "…" : s}»`);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Ожидаемые подписи горизонта «колл» по плану (report.ts:88, metrics.ts:166). */
const callLabels = (callDmy: string) => ({
  horizonLabel: "колла " + callDmy, // yield.horizon_label
  valueLabel: "к коллу " + callDmy, // yield.values[0].label
  lineRe: new RegExp("удержании до колла " + esc(callDmy)), // yield.line
});
/** Ожидаемые подписи горизонта «погашение» (как сейчас — формат меняться не должен). */
const matLabels = (matDmy: string) => ({
  horizonLabel: "погашения " + matDmy,
  valueLabel: "к погашению " + matDmy,
  lineRe: new RegExp("удержании до погашения " + esc(matDmy)),
});

/** Сверка блока yield отчёта с ожидаемым горизонтом; возвращает список расхождений (пусто = всё как в плане). */
function horizonProblems(
  tag: string, y: BondReportT["yield"],
  want: { horizon: "call" | "maturity"; dateDmy: string; horizonLabel: string; valueLabel: string; lineRe: RegExp; mainPct: number | null },
): string[] {
  const label0 = y.values[0]?.label ?? null;
  const t = tag ? tag + " " : "";
  const p: string[] = [];
  if (y.horizon !== want.horizon) p.push(`${t}yield.horizon=${JSON.stringify(y.horizon)} (ждём "${want.horizon}")`);
  if (y.horizon_date !== want.dateDmy) p.push(`${t}horizon_date=${JSON.stringify(y.horizon_date)} (ждём ${want.dateDmy})`);
  if (y.horizon_label !== want.horizonLabel) p.push(`${t}horizon_label=${q(y.horizon_label)} (ждём ${q(want.horizonLabel)})`);
  if (label0 !== want.valueLabel) p.push(`${t}values[0].label=${q(label0)} (ждём ${q(want.valueLabel)})`);
  if (y.line == null || !want.lineRe.test(y.line)) p.push(`${t}yield.line=${q(y.line, 150)} (ждём фрагмент /${want.lineRe.source}/)`);
  if (want.mainPct == null || y.main_pct !== want.mainPct) p.push(`${t}main_pct=${fmt(y.main_pct)} ≠ ${fmt(want.mainPct)} — число меняться не должно`);
  return p;
}

const k0Of = (r: BondReportT) => r.fees_tax.k_grid.find(([k]) => k === 0) ?? null;
const ratesOf = (r: BondReportT) => r.worst.find((w) => w.id === "rates") ?? null;
const derivedBrief = (r: BondReportT) => {
  const k0 = k0Of(r);
  const w = ratesOf(r);
  return `k_grid[k=0]=${k0 ? `[pre ${fmt(k0[1])}, post ${fmt(k0[2])}]` : "нет"}, worst.rates=${q(w?.text ?? null, 110)}`;
};

/**
 * Производные от горизонта блоки — к ТОМУ ЖЕ горизонту, что main (один h на отчёт, принцип 2 плана):
 *  - fees_tax.k_grid[k=0].pre (доходность без комиссии от показанной цены) = own к горизонту main
 *    (к коллу — yieldModel().call.y, к погашению — yieldModel().own); сравнение округлённых до 0,01 значений без допуска —
 *    это один и тот же расчёт yieldOf от той же цены к тому же горизонту;
 *  - worst «Рост ставок».text содержит дату горизонта main (DD.MM.YYYY); формулировка не оценивается.
 *    Дата другого горизонта в том же тексте — справочно (otherDmy печатается, вердикт не меняет).
 * Столбик post (после налога) не утверждается — печатается справочно.
 */
function derivedProblems(tag: string, r: BondReportT, want: { k0Pre: number | null; horizonDmy: string; otherDmy: string }): string[] {
  const t = tag ? tag + " " : "";
  const p: string[] = [];
  const k0 = k0Of(r);
  if (!k0) p.push(`${t}fees_tax.k_grid без строки k=0 (сетка: ${JSON.stringify(r.fees_tax.k_grid)})`);
  else if (want.k0Pre == null || k0[1] !== want.k0Pre)
    p.push(`${t}fees_tax.k_grid[k=0].pre=${fmt(k0[1])} ≠ own к горизонту main ${fmt(want.k0Pre)} — комиссии/налог считаются к другому горизонту`);
  const w = ratesOf(r);
  if (!w) p.push(`${t}worst без пункта rates`);
  else if (!w.text.includes(want.horizonDmy))
    p.push(
      `${t}worst.rates.text=${q(w.text, 150)} — нет даты горизонта main «${want.horizonDmy}»` +
        (w.text.includes(want.otherDmy) ? ` (есть дата другого горизонта «${want.otherDmy}» — worst считается к другому горизонту)` : ""),
    );
  return p;
}
/** Справочная пометка: упоминает ли worst.rates дату другого горизонта (не утверждается). */
const otherDateNote = (r: BondReportT, otherDmy: string) =>
  ratesOf(r)?.text.includes(otherDmy) ? `; worst.rates упоминает также дату другого горизонта ${otherDmy} (справочно)` : "";

/** Горизонт «колл» для фактов — как его должен построить движок после правки (red = остаток × цена колла). */
function callHorizon(b: BondFacts): Horizon {
  if (!b.offerDateIso) throw new Error("callHorizon: нет даты колла");
  const t = yearsBetween(b.todayIso, b.offerDateIso);
  const remain = (b.face ?? 0) - b.amortFuture.filter((a) => a.t < t).reduce((s, a) => s + a.value, 0);
  return { t, red: (remain * (b.offerPrice ?? 100)) / 100, label: "колла " + dmy(b.offerDateIso), dateIso: b.offerDateIso, kind: "call" };
}
/** Горизонт «погашение», построенный харнесом (как metrics.ts:48 сейчас) — опорный YTM для предусловий синтетики,
 *  не зависящий от того, что yieldModel().own будет означать после правки. */
function matHorizon(b: BondFacts): Horizon {
  return { t: (b.daysMat ?? 0) / 365, red: b.face ?? 0, label: "погашения " + (dmy(b.matIso) ?? "—"), dateIso: b.matIso, kind: "maturity" };
}

/** Все строковые листья отчёта с путями — для поиска «null» в человекочитаемых текстах. */
function stringLeaves(v: unknown, p = "report"): [string, string][] {
  if (typeof v === "string") return [[p, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => stringLeaves(x, `${p}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => stringLeaves(x, `${p}.${k}`));
  return [];
}

/** Снимок №1 (securities + marketdata_yields) фикстуры call_telhol — сырые поля биржи для сверки. */
function telholRaw() {
  const dir = path.join(FIXTURES_DIR, "call_telhol");
  const sec = snapshotRows(dir, "engines_stock_markets_bonds_boards_TQCB_securities", "securities")[0] ?? {};
  const my = snapshotRows(dir, "engines_stock_markets_bonds_boards_TQCB_securities", "marketdata_yields")[0] ?? {};
  const cps = snapshotRows(dir, "bondization", "coupons") as { coupondate: string; value: number | null }[];
  return { sec, my, cps };
}

/** Предусловия фикстуры: рублёвая колл-бумага, биржа считает к OFFER и отдаёт число. Нарушение = дефект харнеса/фикстуры →
 *  ERROR, не RED. exchange.used_as_main намеренно НЕ требуется (см. шапку). */
function assertTelholPreconditions(r: BondReportT, b: BondFacts, callIso: string, yieldDate: string) {
  const bad: string[] = [];
  if (r.status.kind !== "ok") bad.push(`status.kind=${r.status.kind}`);
  if (r.product.offer.type !== "call") bad.push(`product.offer.type=${r.product.offer.type}`);
  if (r.yield.exchange.datetype !== "OFFER") bad.push(`exchange.datetype=${r.yield.exchange.datetype}`);
  if (b.moexYDatetype !== "OFFER") bad.push(`facts.moexYDatetype=${b.moexYDatetype}`);
  if (b.offerKind !== "call") bad.push(`facts.offerKind=${b.offerKind}`);
  if (b.offerDateIso !== callIso) bad.push(`facts.offerDateIso=${b.offerDateIso} ≠ CALLOPTIONDATE ${callIso}`);
  if (yieldDate !== callIso) bad.push(`marketdata_yields.YIELDDATE=${yieldDate} ≠ CALLOPTIONDATE ${callIso}`);
  if (b.moexY == null || b.moexYPrice == null || r.yield.exchange.pct == null) bad.push(`биржевой пары нет: moexY=${b.moexY}, moexYPrice=${b.moexYPrice}, exchange.pct=${r.yield.exchange.pct}`);
  if (b.fu !== "SUR" && b.fu !== "RUB") bad.push(`FACEUNIT=${b.fu} — биржевое число основой не станет`);
  if (bad.length) throw new Error("фикстура call_telhol не отвечает предусловиям WP-F: " + bad.join("; "));
}

/* ───── проверки ───── */

export const checks: Check[] = [
  {
    id: "F.1",
    wp: "F",
    kind: "fixture",
    title: "Колл-бумага с datetype OFFER: горизонт отчёта «call», дата = дата колла, подписи «колла DD.MM.YYYY» / «к коллу …» / «удержании до колла …», число не меняется; k_grid[k=0].pre и worst «Рост ставок» — к тому же горизонту",
    async run() {
      const r = reportOf(await buildFixture("call_telhol"));
      const b = await fixtureFacts("call_telhol");
      const { sec, my } = telholRaw();
      const callIso = String(sec.CALLOPTIONDATE ?? "");
      assertTelholPreconditions(r, b, callIso, String(my.YIELDDATE ?? ""));
      const callDmy = dmy(callIso)!; // 25.03.2027
      const matDmy = dmy(b.matIso) ?? "—"; // 14.03.2029
      const ym = yieldModel(b, {});
      const y = r.yield;
      // Число не менять: показанное — yield-to-worst = min(биржа к коллу, свой к коллу)
      const expectMain = ym.call?.y != null && b.moexY != null ? round2(Math.min(b.moexY, ym.call.y)) : null;
      // Сетка комиссий всегда от own: при горизонте «колл» k=0 обязан равняться own к коллу (= call.y той же сборки)
      const ownToCall = ym.call?.y != null ? round2(ym.call.y) : null;
      const labels = callLabels(callDmy);

      const problems = horizonProblems("", y, { horizon: "call", dateDmy: callDmy, ...labels, mainPct: expectMain });
      problems.push(...derivedProblems("", r, { k0Pre: ownToCall, horizonDmy: callDmy, otherDmy: matDmy }));

      // Справочно (не утверждается): после налога к коллу — afterTax движка с горизонтом колла, построенным харнесом;
      // YTM к погашению по горизонту харнеса — чтобы видеть, что заменённое число и впрямь min
      const postToCall = ym.cleanPct != null ? afterTax(b, ym.cleanPct, 0, 1, callHorizon(b)) : null;
      const ytmHarness = ym.cleanPct != null ? yieldOf(b, ym.cleanPct, 0, 1, matHorizon(b)) : null;

      const ctx =
        `ISS №1: CALLOPTIONDATE=${sec.CALLOPTIONDATE}, BUYBACKDATE=${sec.BUYBACKDATE}, BUYBACKPRICE=${sec.BUYBACKPRICE}, MATDATE=${sec.MATDATE}; ` +
        `marketdata_yields: YIELDDATETYPE=${my.YIELDDATETYPE}, YIELDDATE=${my.YIELDDATE}, EFFECTIVEYIELDWAPRICE=${my.EFFECTIVEYIELDWAPRICE} @ WAPRICE ${my.WAPRICE}. ` +
        `Факты: moexYDatetype=${b.moexYDatetype}, offerKind=${b.offerKind}, horizon(b).kind=${horizon(b).kind}. ` +
        `Отчёт: horizon=${y.horizon}, horizon_date=${y.horizon_date}, horizon_label=${q(y.horizon_label)}, values[0].label=${q(y.values[0]?.label)}, main_pct=${fmt(y.main_pct)} ` +
        `(exchange.pct=${fmt(y.exchange.pct)}, used_as_main=${y.exchange.used_as_main}, own к коллу call.y=${fmt(ym.call?.y)}, own движка=${fmt(ym.own)}, YTM к погашению по горизонту харнеса=${fmt(ytmHarness)}; ожидаем min=${fmt(expectMain)}), ` +
        `line=${q(y.line, 170)}. Производные блоки: ${derivedBrief(r)}; ожидаем k_grid[k=0].pre = own к коллу ${fmt(ownToCall)} ` +
        `(здесь = main_pct, т.к. main заменён call.y), worst.rates ∋ дата ${callDmy}${otherDateNote(r, matDmy)}; справочно post к коллу (afterTax, горизонт харнеса) = ${fmt(postToCall)}. ` +
        `Ожидаемые подписи: horizon_label ${q(labels.horizonLabel)}, values[0].label ${q(labels.valueLabel)}, line ∋ «удержании до колла ${callDmy}»`;
      return expect(problems.length === 0, (problems.length ? problems.join(" | ") + ". " : "") + ctx);
    },
  },

  {
    id: "F.2",
    wp: "F",
    kind: "unit",
    title: "Синтетика (колл через 365 дн.): (а) min(main, call.y)=call.y → «call»; (б) call.y > YTM → «maturity»; (в) биржа OFFER без замены → «call», число = moexY; (г) биржа MATDATE → «maturity»; k_grid[k=0].pre и worst.rates — к горизонту main",
    run() {
      const today = "2026-10-09";
      const callIso = "2027-10-09"; // 365 дней — не «скорый» колл (callSoonDays = 30)
      const matIso = "2029-10-08";
      const callDmy = dmy(callIso)!; // 09.10.2027
      const matDmy = dmy(matIso)!; // 08.10.2029
      const cl = callLabels(callDmy);
      const ml = matLabels(matDmy);
      const mk = (price: number, over: Partial<BondFacts> = {}) =>
        facts({
          todayIso: today, matIso, daysMat: 1095,
          coupons: coupons(today, 6, 182, (1000 * 0.12 * 182) / 365),
          offerKind: "call", offerDateIso: callIso, offerPrice: 100,
          wap: price, prevWap: price, bid: price - 0.1, offerQ: price + 0.1,
          moexY: null, moexYPrice: null, moexYDatetype: null, // биржевой доходности нет → main = own, замена только через min
          ...over,
        });
      // Опорный YTM к погашению — по горизонту харнеса, не yieldModel().own (см. шапку: own после правки может стать «к h»)
      const ytmOf = (b: BondFacts) => yieldOf(b, b.wap ?? 0, 0, 1, matHorizon(b));
      const problems: string[] = [];
      const brief = (r: BondReportT) => {
        const y = r.yield;
        return `horizon=${y.horizon}, horizon_date=${y.horizon_date}, horizon_label=${q(y.horizon_label)}, values[0].label=${q(y.values[0]?.label)}, main_pct=${fmt(y.main_pct)}, line=${q(y.line, 120)}; ${derivedBrief(r)}`;
      };

      // (а) цена выше номинала, биржевой доходности нет: YTM > call.y → main заменён call.y → горизонт «call» (правило 2);
      //     k_grid[k=0].pre = own к коллу = call.y = main (здесь все три — одно число), worst.rates — к коллу.
      //     Предусловие — только соотношение YTM(харнес) и call.y(движок); «main = call.y» утверждается, не предполагается.
      const bA = mk(104);
      const ymA = yieldModel(bA, {});
      const ytmA = ytmOf(bA);
      if (!ymA.call || ymA.call.short || ymA.call.y == null || ytmA == null || !(ymA.call.y < ytmA))
        throw new Error(`синтетика (а) не воспроизводит сценарий: YTM(харнес)=${fmt(ytmA)}, call.y=${fmt(ymA.call?.y)}, short=${ymA.call?.short}`);
      const rA = assembleReport(bA, {});
      problems.push(...horizonProblems("(а)", rA.yield, { horizon: "call", dateDmy: callDmy, ...cl, mainPct: round2(ymA.call.y) }));
      problems.push(...derivedProblems("(а)", rA, { k0Pre: round2(ymA.call.y), horizonDmy: callDmy, otherDmy: matDmy }));

      // (б) цена ниже номинала: к коллу выгоднее → min оставляет YTM → горизонт «maturity» (защита от «всё колл»);
      //     k_grid[k=0].pre = own к погашению = main (сейчас так — защита от регресса). Горизонт здесь погашение, поэтому
      //     yieldModel().own однозначен (YTM) и годится как ожидание.
      const bB = mk(96);
      const ymB = yieldModel(bB, {});
      const ytmB = ytmOf(bB);
      if (!ymB.call || ymB.call.y == null || ymB.own == null || ytmB == null || !(ymB.call.y > ytmB))
        throw new Error(`синтетика (б) не воспроизводит сценарий: YTM(харнес)=${fmt(ytmB)}, own=${fmt(ymB.own)}, call.y=${fmt(ymB.call?.y)}`);
      const rB = assembleReport(bB, {});
      problems.push(...horizonProblems("(б)", rB.yield, { horizon: "maturity", dateDmy: matDmy, ...ml, mainPct: round2(ymB.own) }));
      problems.push(...derivedProblems("(б)", rB, { k0Pre: round2(ymB.own), horizonDmy: matDmy, otherDmy: callDmy }));

      // (в) биржа считает к коллу (YIELDDATETYPE=OFFER) и её число НИЖЕ call.y → min ничего не меняет, main = moexY;
      //     горизонт «call» должен прийти из правила 1 (datetype OFFER ∧ offerKind call), а не из замены. Число = 7.8 без изменений.
      //     k_grid[k=0].pre = own к коллу (call.y), а не main: сетка всегда от own, биржевое число в неё не входит.
      const bC = mk(104, { moexY: 7.8, moexYPrice: 104, moexYDatetype: "OFFER" });
      const ymC = yieldModel(bC, {});
      if (!ymC.useMoex || ymC.main !== bC.moexY || !ymC.call || ymC.call.short || ymC.call.y == null || !(ymC.call.y > (bC.moexY ?? 0)))
        throw new Error(`синтетика (в) не воспроизводит сценарий: useMoex=${ymC.useMoex}, main=${fmt(ymC.main)}, moexY=${fmt(bC.moexY)}, call.y=${fmt(ymC.call?.y)}, short=${ymC.call?.short}`);
      const rC = assembleReport(bC, {});
      problems.push(...horizonProblems("(в)", rC.yield, { horizon: "call", dateDmy: callDmy, ...cl, mainPct: bC.moexY }));
      if (rC.yield.exchange.datetype !== "OFFER" || rC.yield.exchange.pct !== bC.moexY) problems.push(`(в) exchange=${JSON.stringify(rC.yield.exchange)} (ждём datetype OFFER, pct ${fmt(bC.moexY)})`);
      problems.push(...derivedProblems("(в)", rC, { k0Pre: round2(ymC.call.y), horizonDmy: callDmy, otherDmy: matDmy }));

      // (г) симметрия: биржа считает к погашению (MATDATE), её число ниже call.y → замены нет, датотип не колл → горизонт «maturity».
      //     Ловит реализацию «у колл-бумаги есть биржевая доходность → call» без проверки datetype. k_grid[k=0].pre = own к погашению.
      const bD = mk(104, { moexY: 7.8, moexYPrice: 104, moexYDatetype: "MATDATE" });
      const ymD = yieldModel(bD, {});
      if (!ymD.useMoex || ymD.main !== bD.moexY || !ymD.call || ymD.call.y == null || ymD.own == null || !(ymD.call.y > (bD.moexY ?? 0)))
        throw new Error(`синтетика (г) не воспроизводит сценарий: useMoex=${ymD.useMoex}, main=${fmt(ymD.main)}, moexY=${fmt(bD.moexY)}, call.y=${fmt(ymD.call?.y)}`);
      const rD = assembleReport(bD, {});
      problems.push(...horizonProblems("(г)", rD.yield, { horizon: "maturity", dateDmy: matDmy, ...ml, mainPct: bD.moexY }));
      problems.push(...derivedProblems("(г)", rD, { k0Pre: round2(ymD.own), horizonDmy: matDmy, otherDmy: callDmy }));

      const ctx =
        `(а) цена 104, биржи нет: YTM(харнес)=${fmt(ytmA)}, own движка=${fmt(ymA.own)}, call.y=${fmt(ymA.call.y)}, main=${fmt(ymA.main)} (ждём =call.y, заменён), колл через ${ymA.call.days} дн.; ждём k_grid[k=0].pre=${fmt(round2(ymA.call.y))}, worst.rates ∋ ${callDmy}${otherDateNote(rA, matDmy)}; отчёт: ${brief(rA)}. ` +
        `(б) цена 96, биржи нет: YTM(харнес)=${fmt(ytmB)}, own движка=${fmt(ymB.own)}, call.y=${fmt(ymB.call.y)}, main=${fmt(ymB.main)} (=own, не заменён); ждём k_grid[k=0].pre=${fmt(round2(ymB.own))}, worst.rates ∋ ${matDmy}${otherDateNote(rB, callDmy)}; отчёт: ${brief(rB)}. ` +
        `(в) цена 104, биржа OFFER 7.80: own движка=${fmt(ymC.own)}, call.y=${fmt(ymC.call.y)}, main=${fmt(ymC.main)} (=moexY, useMoex=${ymC.useMoex}, замены нет); ждём k_grid[k=0].pre=${fmt(round2(ymC.call.y))} (own к коллу, ≠ main — норма), worst.rates ∋ ${callDmy}${otherDateNote(rC, matDmy)}; отчёт: ${brief(rC)}. ` +
        `(г) цена 104, биржа MATDATE 7.80: main=${fmt(ymD.main)} (=moexY), call.y=${fmt(ymD.call.y)}, own=${fmt(ymD.own)}; ждём k_grid[k=0].pre=${fmt(round2(ymD.own))}, worst.rates ∋ ${matDmy}${otherDateNote(rD, callDmy)}; отчёт: ${brief(rD)}. ` +
        `Ожидаемые подписи колла: horizon_label ${q(cl.horizonLabel)}, values[0].label ${q(cl.valueLabel)}, line ∋ «удержании до колла ${callDmy}»`;
      return expect(problems.length === 0, (problems.length ? problems.join(" | ") + ". " : "") + ctx);
    },
  },

  {
    id: "F.3",
    wp: "F",
    kind: "fixture",
    title: "Колл-фикстура: контроль own↔биржа к одному горизонту — control_diff_pp ≤ 0,5 п.п. (литерал плана, не CONFIG)",
    async run() {
      const LIMIT_PP = 0.5; // планка из плана («F.3 … control_diff_pp ≤ 0,5»); CONFIG.controlWarnPp печатается справочно и на вердикт не влияет
      const r = reportOf(await buildFixture("call_telhol"));
      const b = await fixtureFacts("call_telhol");
      const { sec, my, cps } = telholRaw();
      const callIso = String(sec.CALLOPTIONDATE ?? "");
      assertTelholPreconditions(r, b, callIso, String(my.YIELDDATE ?? ""));

      // Like-for-like: свой расчёт от цены биржи (moexYPrice) к горизонту биржи (колл), движком и независимо
      const hCall = callHorizon(b);
      const ownToCall = b.moexYPrice != null ? yieldOf(b, b.moexYPrice, 0, 1, hCall) : null;
      const ownToMat = b.moexYPrice != null ? yieldOf(b, b.moexYPrice, 0, 1, matHorizon(b)) : null;
      const indep = (fromIso: string) => {
        const P = ((b.moexYPrice ?? 0) * (b.face ?? 0)) / 100 + (b.acc ?? 0);
        const flows: [number, number][] = cps
          .filter((c) => c.coupondate > fromIso && c.coupondate <= callIso && c.value != null)
          .map((c) => [yearsBetween(fromIso, c.coupondate), c.value as number]);
        flows.push([yearsBetween(fromIso, callIso), ((b.face ?? 0) * (b.offerPrice ?? 100)) / 100]);
        return { y: irr(P, flows), n: flows.length - 1, P };
      };
      const iToday = indep(b.todayIso);
      const iSettle = indep(String(sec.SETTLEDATE ?? b.todayIso));

      const diff = r.yield.control_diff_pp;
      const ok = diff != null && diff <= LIMIT_PP;
      const ctl = r.diagnostics.warnings.filter((w) => /контроль/i.test(w));
      const cfgNote =
        CONFIG.controlWarnPp > LIMIT_PP ? " — выше планки плана, вердикт F.3 от неё не зависит" : "";
      const detail =
        `control_diff_pp=${fmt(diff)} (планка плана ${LIMIT_PP}; CONFIG.controlWarnPp=${CONFIG.controlWarnPp}${cfgNote}); own_control_pct=${fmt(r.yield.own_control_pct)} — движок считает к ${horizon(b).label} ` +
        `(horizon(b).kind=${horizon(b).kind}), биржа exchange.pct=${fmt(r.yield.exchange.pct)} (used_as_main=${r.yield.exchange.used_as_main}) — к ${my.YIELDDATETYPE} ${dmy(String(my.YIELDDATE))} от WAPRICE ${fmt(b.moexYPrice)}. ` +
        `Like-for-like к коллу ${dmy(callIso)} от той же цены: движок yieldOf(…, hCall)=${fmt(ownToCall)} (Δ ${fmt(ownToCall != null && b.moexY != null ? Math.abs(ownToCall - b.moexY) : null)}), ` +
        `независимый IRR (${iToday.n} купонов + ${fmt(((b.face ?? 0) * (b.offerPrice ?? 100)) / 100, 0)} в дату колла, P=${fmt(iToday.P)}): от todayIso ${fmt(iToday.y)}, от SETTLEDATE ${sec.SETTLEDATE} ${fmt(iSettle.y)}; ` +
        `к погашению ${dmy(b.matIso)} движок даёт ${fmt(ownToMat)}. warnings: ${ctl.length ? ctl.map((w) => q(w, 120)).join("; ") : "нет предупреждений контроля"}`;
      return expect(ok, detail);
    },
  },

  {
    id: "F.4",
    wp: "F",
    kind: "unit",
    title: "Put без даты (offerDateIso = null): тексты отчёта (plain_text, yield.line, worst, flags) без «null»/«undefined»/«NaN» и без пустого/заглушечного слота даты после «с офертой»",
    run() {
      // ISS-реалистично: BONDSUBTYPE «(put)» без PUTOPTIONDATE и без будущих offers → дата null, цена принята за номинал.
      // reset здесь false намеренно: facts.ts:224 ставит reset только при известной дате оферты, поэтому флаг 9 / worst.reset
      // для put без даты не возникают и этим сценарием не покрываются.
      const b = facts({ offerKind: "put", offerDateIso: null, offerPrice: 100, offerPriceAssumedPar: true });
      const r = assembleReport(b, {});
      const leaves = stringLeaves(r);
      const leakRe = /\bnull\b|\bundefined\b|\bNaN\b/;
      const offenders = leaves.filter(([, s]) => leakRe.test(s));
      const must = [["product.plain_text", r.product.plain_text], ["yield.line", r.yield.line ?? ""]] as const;
      const mustBad = must.filter(([, s]) => leakRe.test(s)).map(([p]) => p);

      // Пустой или заглушечный слот даты — тот же null, отрисованный пустотой/прочерком/вопросом внутри прежнего шаблона
      // «с офертой {дата}: в эту дату …». Распознаются две формы:
      //   (A) после «с офертой» идут пробел(ы), затем (необязательно) «—»/«?»/«n/a» и сразу знак препинания — артефакт
      //       `${dmy(...) ?? ""}` («с офертой :», «с офертой —:», «с офертой ?:»); в русской типографике пробела перед
      //       знаком препинания нет, поэтому «с офертой: дата не указана…» и «с офертой, дата…» сюда НЕ попадают;
      //   (B) шаблонное продолжение «в эту дату» сразу после «с офертой» (с пустым слотом/заглушкой/двоеточием) —
      //       «с офертой: в эту дату», «с офертой в эту дату».
      // Не распознаются: словесные заглушки («с офертой неизвестно:», «с офертой (дата?)»), а также висящее «в эту дату»
      // после пояснения («с офертой (дата не указана): в эту дату…») — план формулировку не задаёт, это печатается справочно.
      const pt = r.product.plain_text;
      const emptySlotA = /с офертой\s+(?:[—–-]+|\?+|n\/a)?\s*[:;,.]/i;
      const emptySlotB = /с офертой\s*(?:[—–-]+|\?+|n\/a)?\s*[:;,.]?\s*в эту дату/i;
      const emptySlot = emptySlotA.test(pt) || emptySlotB.test(pt);
      // Справочно (не утверждается — план формулировку не задаёт): пояснение, что дата не раскрыта/не указана,
      // и висящая ссылка «в эту дату» при отсутствующей дате
      const noteRe = /дат[аы][^.]{0,40}?не\s*(указан|раскрыт|объявлен|определен|известн|назначен)|нет даты|без даты/i;
      const hasNote = noteRe.test(pt);
      const danglingRef = /в эту дату/i.test(pt);

      const detail =
        (offenders.length
          ? `«null»/«undefined»/«NaN» в ${offenders.length} текстовых полях: ${offenders.map(([p, s]) => `${p}=${q(s, 150)}`).join("; ")}. `
          : "«null»/«undefined»/«NaN» нет ни в одном текстовом поле отчёта. ") +
        (emptySlot ? `plain_text: пустой/заглушечный слот даты после «с офертой» (${emptySlotA.test(pt) ? "форма A: пробел + знак препинания" : "форма B: шаблонное «в эту дату»"}). ` : "") +
        `product.offer=${JSON.stringify(r.product.offer)}; horizon=${r.yield.horizon} ${q(r.yield.horizon_label)}; ` +
        `plain_text целиком=${q(pt, 1000)}; справочно: пояснение об отсутствии даты — ${hasNote ? "есть" : "нет"}, фраза «в эту дату» при отсутствующей дате — ${danglingRef ? "есть" : "нет"}; yield.line=${q(r.yield.line, 120)}` +
        (mustBad.length ? ` (обязательные поля с дефектом: ${mustBad.join(", ")})` : "");
      return expect(offenders.length === 0 && !emptySlot, detail);
    },
  },
];
