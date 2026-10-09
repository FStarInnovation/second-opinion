/** WP-B — проверки по docs/AUDIT_PLAN_2026-10-09.md. Каждая утверждает ЖЕЛАЕМОЕ поведение; до правки — RED.
 *
 *  Корневая причина WP-B: собственный расчёт считает время потоков от todayIso (T+0, причём по UTC),
 *  а биржа — от SETTLEDATE (T+1; в пятницу — понедельник); горизонт берётся из DAYSTOREDEMPTION (календарь МСК),
 *  купоны — от UTC-даты. Отсюда: ложный «контроль» 0,12–0,66 п.п. (B.1), два разных «без комиссии» в одном
 *  отчёте (B.2), валютный НКД на T+0 (B.3), UTC-день вместо МСК (B.4), выпадение купона в дату погашения (B.5).
 */
import fs from "node:fs";
import path from "node:path";
import { collectFacts } from "../../iss/facts";
import { horizon, yieldOf } from "../../metrics";
import type { BondReportT } from "../../contract";
import {
  type Check, approx, expect, fail, fmt,
  buildFixture, buildGolden, goldenCases, snapshotRows, reportOf, facts, coupons, irr,
  GOLDEN_DIR, FIXTURES_DIR,
} from "../lib";

const DAY = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * DAY).toISOString().slice(0, 10);
const daysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY);

/** SETTLEDATE из снимка №1 (таблица securities); null — таблица пуста (нет торгов) или снимка нет */
function settleOf(dir: string): string | null {
  try {
    const v = snapshotRows(dir, "engines_stock_markets_bonds_boards", "securities")[0]?.SETTLEDATE;
    return typeof v === "string" && ISO.test(v) ? v : null;
  } catch {
    return null;
  }
}

interface Built { name: string; report: BondReportT; today: string; dir: string }

/** Все golden-кейсы, давшие отчёт (kind report), плюс названные фикстуры харнеса */
async function reportsOf(fixtures: string[]): Promise<Built[]> {
  const out: Built[] = [];
  const meta = goldenCases();
  for (const c of meta.cases) {
    const res = await buildGolden(c.name);
    if (res.kind !== "report") continue;
    out.push({ name: `golden/${c.name}`, report: res.report, today: c.todayIso ?? meta.todayIso, dir: path.join(GOLDEN_DIR, "snapshots", c.name) });
  }
  for (const f of fixtures) {
    const dir = path.join(FIXTURES_DIR, f);
    const m = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { todayIso: string };
    out.push({ name: `fixture/${f}`, report: reportOf(await buildFixture(f)), today: m.todayIso, dir });
  }
  return out;
}

/** «today 2026-10-08, SETTLEDATE 2026-10-09 (T+1)» — чтобы по RED было видно сдвиг дат */
function datesOf(x: Built): string {
  const settle = settleOf(x.dir);
  const shift = settle ? daysBetween(x.today, settle) : null;
  return `today ${x.today}, SETTLEDATE ${settle ?? "—"}${shift != null ? ` (T+${shift})` : ""}`;
}

/* ───── B.4: подмена системных часов ───── */
/** Date, у которого «сейчас» = fixedMs; остальное (parse, конструктор с аргументом) — настоящее.
 *  В движке Date используется только как new Date() / new Date(ms) / Date.parse (facts.ts:86,132; report.ts:138). */
function fakeDateAt(fixedMs: number): DateConstructor {
  const Real = Date;
  class FakeDate extends Real {
    constructor(value?: number | string | Date) {
      super(value === undefined ? fixedMs : value);
    }
    static now(): number { return fixedMs; }
  }
  return FakeDate as unknown as DateConstructor;
}

export const checks: Check[] = [
  {
    id: "B.1",
    wp: "B",
    kind: "fixture",
    title: "Контроль формулы: |свой расчёт − биржа| ≤ 0,05 п.п. на всех golden со status ok и на пятничном снимке РОЛЬФ",
    async run() {
      const TOL = 0.05;
      const all = await reportsOf(["rolf_friday", "ofz26244"]);
      const rows = all.filter((x) => x.report.status.kind === "ok" && x.report.yield.control_diff_pp != null);
      if (rows.length === 0) return fail("нет ни одного отчёта со status ok и control_diff_pp — проверять нечего");
      const bad = rows.filter((x) => x.report.yield.control_diff_pp! > TOL);
      const show = (x: Built) => {
        const y = x.report.yield;
        return `${x.name}: Δ ${fmt(y.control_diff_pp)} (own ${fmt(y.own_control_pct)} vs биржа ${fmt(y.exchange.pct)} от цены ${fmt(y.exchange.price_pct, 3)}%; ${datesOf(x)})`;
      };
      const good = rows.filter((x) => !bad.includes(x));
      return expect(
        bad.length === 0,
        `${bad.length} из ${rows.length} отчётов с control_diff_pp > ${TOL} п.п.` +
          (bad.length ? ` — ${bad.map(show).join("; ")}` : "") +
          (good.length ? ` | в допуске: ${good.map(show).join("; ")}` : ""),
      );
    },
  },
  {
    id: "B.2",
    wp: "B",
    kind: "fixture",
    title: "Одна «доходность без комиссии»: при биржевой доходности как главной k_grid[0].pre = main_pct (±0,05 п.п.)",
    async run() {
      const TOL = 0.05;
      const all = await reportsOf(["rolf_friday"]);
      const rows = all.filter((x) => x.report.yield.exchange.used_as_main);
      if (rows.length === 0) return fail("нет ни одного отчёта с yield.exchange.used_as_main = true — проверять нечего");
      const res = rows.map((x) => {
        const y = x.report.yield;
        const g = x.report.fees_tax.k_grid[0];
        const pre = g?.[1] ?? null;
        const ok = g != null && g[0] === 0 && approx(pre, y.main_pct, TOL);
        const d = pre != null && y.main_pct != null ? pre - y.main_pct : null;
        const callNote = y.main_pct != null && y.exchange.pct != null && y.main_pct !== y.exchange.pct ? "; main ≠ exchange.pct — main заменён call.y (WP-F)" : "";
        const line =
          `${x.name}: k_grid[0] = [${g ? g.map((v) => fmt(v)).join(", ") : "пусто"}] vs main_pct ${fmt(y.main_pct)} (Δ ${fmt(d)}; ` +
          `exchange.pct ${fmt(y.exchange.pct)} от ${fmt(y.exchange.price_pct, 3)}%, price.clean_pct ${fmt(x.report.price.clean_pct, 3)}%; ${datesOf(x)}${callNote})`;
        return { ok, line };
      });
      const bad = res.filter((r) => !r.ok);
      const good = res.filter((r) => r.ok);
      return expect(
        bad.length === 0,
        `${bad.length} из ${res.length} отчётов с |k_grid[0].pre − main_pct| > ${TOL} п.п.` +
          (bad.length ? ` — ${bad.map((r) => r.line).join("; ")}` : "") +
          (good.length ? ` | в допуске: ${good.map((r) => r.line).join("; ")}` : ""),
      );
    },
  },
  {
    id: "B.3",
    wp: "B",
    kind: "fixture",
    title: "Валютный НКД (golden cherk2p1, CNY) начислен на дату расчётов SETTLEDATE по конвенции ISS",
    async run() {
      const name = "cherk2p1";
      const dir = path.join(GOLDEN_DIR, "snapshots", name);
      const sec = snapshotRows(dir, "engines_stock_markets_bonds_boards", "securities")[0];
      if (!sec) throw new Error(`${name}: пустая таблица securities в снимке №1`);
      const cpv = Number(sec.COUPONVALUE);
      const period = Number(sec.COUPONPERIOD);
      const next = String(sec.NEXTCOUPON);
      const settle = String(sec.SETTLEDATE);
      const accRub = Number(sec.ACCRUEDINT);
      if (!Number.isFinite(cpv) || !Number.isFinite(period) || period <= 0 || !ISO.test(next) || !ISO.test(settle))
        throw new Error(`${name}: в снимке нет полей для эталона: COUPONVALUE=${String(sec.COUPONVALUE)} COUPONPERIOD=${String(sec.COUPONPERIOD)} NEXTCOUPON=${next} SETTLEDATE=${settle}`);
      const meta = goldenCases();
      const today = meta.cases.find((c) => c.name === name)?.todayIso ?? meta.todayIso;
      // П12: НКД_ном = COUPONVALUE × дни_с_последнего_купона / COUPONPERIOD; дни — до даты расчётов, как ACCRUEDINT биржи
      const sinceFrom = (fromIso: string) => period - daysBetween(fromIso, next);
      const expected = (cpv * sinceFrom(settle)) / period;
      const atToday = (cpv * sinceFrom(today)) / period;
      const r = reportOf(await buildGolden(name));
      const acc = r.price.accruedint;
      const detail =
        `price.accruedint = ${fmt(acc, 3)} ${r.product.faceunit}; эталон ISS на SETTLEDATE ${settle}: ${cpv} × ${sinceFrom(settle)}/${period} = ${expected.toFixed(3)}; ` +
        `от todayIso ${today} (T+0) выходит ${cpv} × ${sinceFrom(today)}/${period} = ${atToday.toFixed(3)}; ` +
        `ACCRUEDINT биржи ${accRub} ₽ ⇒ подразумеваемый курс ${(accRub / expected).toFixed(3)} ₽/CNY при эталоне против ${(accRub / atToday).toFixed(3)} при T+0`;
      return expect(r.product.faceunit === "CNY" && approx(acc, expected, 0.001), detail);
    },
  },
  {
    id: "B.4",
    wp: "B",
    kind: "fixture",
    title: "todayIso движка — календарный день по МСК, не UTC (22:30Z 08.10 = 01:30 МСК 09.10 → 2026-10-09)",
    async run() {
      const Real = Date;
      const fixedMs = Real.parse("2026-10-08T22:30:00Z");
      const utcDay = new Real(fixedMs).toISOString().slice(0, 10);
      const mskDay = new Real(fixedMs + 3 * 3_600_000).toISOString().slice(0, 10);
      // Бумага без торгов: collectFacts не ходит за №4 (history), чей снимок именован окном дат от todayIso —
      // иначе при смене «сегодня» снимок не найдётся и проверка упадёт ERROR вместо RED/GREEN
      const dir = path.join(GOLDEN_DIR, "snapshots", "not_traded");
      let todayIso: string;
      let clock: string;
      globalThis.Date = fakeDateAt(fixedMs);
      try {
        clock = new Date().toISOString();
        const f = await collectFacts("RU000A10CZA1", { fromSnapshotDir: dir });
        todayIso = f.todayIso;
      } finally {
        globalThis.Date = Real;
      }
      if (clock !== new Real(fixedMs).toISOString()) throw new Error(`подмена Date не сработала: new Date() = ${clock}`);
      return expect(
        todayIso === mskDay,
        `collectFacts без todayIso при системных часах ${clock}: facts.todayIso = ${todayIso}; день по UTC ${utcDay}, день по МСК ${mskDay} (ожидается МСК; facts.ts:86 берёт new Date().toISOString().slice(0, 10))`,
      );
    },
  },
  {
    id: "B.5",
    wp: "B",
    kind: "unit",
    title: "Купон в дату погашения не выпадает из потоков при расхождении календарей todayIso (UTC) и DAYSTOREDEMPTION (МСК)",
    run() {
      const TOL = 0.05;
      // С 00:00 до 03:00 МСК день по UTC на единицу меньше; DAYSTOREDEMPTION биржа считает по МСК
      const utcDays = ["2026-10-08", "2026-12-31", "2027-06-30"];
      const lines: string[] = [];
      let allOk = true;
      for (const todayUtc of utcDays) {
        const mskDay = addDays(todayUtc, 1);
        const matIso = addDays(todayUtc, 730);
        const cps = coupons(todayUtc, 2, 365, 120); // годовые купоны +365 и +730: последний — в дату погашения
        if (cps[1].dateIso !== matIso) throw new Error(`синтетика: последний купон ${cps[1].dateIso} ≠ погашение ${matIso}`);
        const daysMatMsk = daysBetween(mskDay, matIso); // 729 — как отдаст ISS по МСК
        const base = { todayIso: todayUtc, matIso, coupons: cps, cp: 12, period: 365, nextCouponIso: cps[0].dateIso, durDays: 650 };
        const b = facts({ ...base, daysMat: daysMatMsk });
        const h = horizon(b);
        const y = yieldOf(b, 100, 0, 1, h);
        const ref = irr(1000, [[cps[0].t, 120], [cps[1].t, 120], [cps[1].t, 1000]]);
        // контроль: при согласованных календарях движок и эталон совпадают
        const b0 = facts({ ...base, daysMat: daysBetween(todayUtc, matIso) });
        const y0 = yieldOf(b0, 100, 0, 1, horizon(b0));
        const ok = approx(y, ref, TOL);
        allOk &&= ok;
        lines.push(
          `${ok ? "ok" : "RED"} today(UTC) ${todayUtc} / МСК ${mskDay}, погашение ${matIso}: купон 120 ₽ в дату погашения t=${cps[1].t.toFixed(4)}, ` +
            `горизонт движка t=${h.t.toFixed(4)} (DAYSTOREDEMPTION ${daysMatMsk} по МСК) → yieldOf ${fmt(y)}% vs эталон IRR ${fmt(ref)}% (Δ ${fmt(y != null && ref != null ? y - ref : null)}); ` +
            `при согласованном daysMat=${daysBetween(todayUtc, matIso)}: ${fmt(y0)}%`,
        );
      }
      return expect(allOk, lines.join(" | "));
    },
  },
];
