/**
 * Selftest: без сети (паттерн uw-dashboard / data lake).
 * 1. Юнит-проверки чистых функций.
 * 2. Прогон всех golden-кейсов из замороженных снимков ISS и побайтовое
 *    сравнение с эталонами (изменчивые поля: built_at, snapshot_dir — игнорируются).
 * Выход: 0 — всё зелёное; 1 — расхождения. Результаты в stdout, прогресс в stderr.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build";
import { flags, liquidity, shift, solve, termPhrase, type YieldModel } from "./metrics";
import type { BondFacts } from "./iss/facts";
import { applyInputs } from "./inputs";
import { BondReport } from "./contract";

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(here, "..", "golden");
let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { failures++; console.log(`FAIL  ${name}  ${detail}`); }
  else console.error(`ok    ${name}`);
};

/* 1. Юнит-проверки */
ok("shift: сценарий 1 = 0", shift(1, 0.5) === 0);
ok("shift: сценарий 2, t=0.5 → −1.25", Math.abs(shift(2, 0.5) - -1.25) < 1e-9);
ok("shift: сценарий 2, t=2 → −2.5", Math.abs(shift(2, 2) - -2.5) < 1e-9);
ok("shift: сценарий 3, t=0.5 → +1.5", Math.abs(shift(3, 0.5) - 1.5) < 1e-9);
ok("shift: сценарий 3, t=1.5 → 0", Math.abs(shift(3, 1.5)) < 1e-9);
ok("shift: сценарий 3, t=3 → −1.5", Math.abs(shift(3, 3) - -1.5) < 1e-9);
ok("termPhrase: 107 дней → мес.", termPhrase(107).includes("мес"));
ok("termPhrase: 1971 день → 5,4 года", termPhrase(1971) === "5,4 года");
ok("termPhrase: 365 дней → 1 год", termPhrase(365) === "1 год");
// Нулевой купон (блок 4): y = (N/P)^(365/D) − 1; решатель должен дать то же
const y0 = solve(950, [[1, 1000]]);
ok("solve: дисконтная бумага 950→1000 за год ≈ 5,26%", y0 != null && Math.abs(y0 - (1000 / 950 - 1) * 100) < 0.01, String(y0));

// Бумага без торгов (08.10.2026: купон 0%, нет цены, ни одной сделки — а Truth Score был 90).
// Два пути: а) режима bonds/stock нет вовсе → «не торгуется» (флаг 6); б) режим есть, но в окне ни одной сделки → флаг 4.
const noTrade = (over: Partial<BondFacts>): BondFacts => ({
  secid: "X", isin: null, boardid: null, shortname: "X", secname: null, regnumber: null, emit: null, kind: null,
  todayIso: "2026-10-08", settleIso: "2026-10-09", face: 1000, fu: "SUR", acc: 0, cp: 0, period: null, matIso: "2026-11-08", daysMat: 31,
  nextCouponIso: null, ctype: "zero", r0: null, coupons: [], amortFuture: [], amortized: false,
  offerKind: "none", offerDateIso: null, offerPrice: null, offerPriceAssumedPar: false, reset: false,
  wap: null, prevWap: null, bid: null, offerQ: null, upd: null, tradeDateIso: null,
  moexPairs: [], moexY: null, moexYPrice: null, moexYDatetype: null, moexAtShownPrice: false, g: null, durDays: null,
  stop: false, structured: false, subordinated: false, perpetual: false, lvl: 3, qual: false, hasDefault: false, avg: null, avgNT: null, nDays: 0, ...over,
});
const ymNone = { status: "noPrice", main: null } as unknown as YieldModel;
{
  const b = noTrade({ stop: true }); // а) boards пуст → facts.ts ставит stop
  const liq = liquidity(b, 100_000);
  const f = flags(b, ymNone, liq, null);
  ok("не торгуется: флаг 6 горит, флаг 4 нет", f.fired.some((x) => x.id === 6) && !f.fired.some((x) => x.id === 4), f.fired.map((x) => x.id).join(","));
  ok("не торгуется: score ≤ 60 (−40 за флаг 6)", f.score <= 60, String(f.score));
  ok("не торгуется: категория «—», noExit", liq.cat === "—" && liq.noExit, liq.cat);
}
{
  const b = noTrade({ boardid: "TQCB" }); // б) режим есть, сделок в окне нет
  const liq = liquidity(b, 100_000);
  const f = flags(b, ymNone, liq, null);
  ok("нет сделок в окне: флаг 4 горит", f.fired.some((x) => x.id === 4), f.fired.map((x) => x.id).join(","));
  ok("нет сделок в окне: категория «низкая»", liq.cat === "низкая", liq.cat);
  ok("нет сделок в окне: детали флага 4 без «за 0 дн.»", !f.fired.find((x) => x.id === 4)!.details.includes("0 дн"), f.fired.find((x) => x.id === 4)!.details);
  ok("нет сделок в окне: score < 90 (листинг 3 + неликвид + спред)", f.score <= 65, String(f.score));
}

/* 2. Golden-кейсы из снимков */
const meta = JSON.parse(fs.readFileSync(path.join(goldenDir, "cases.json"), "utf8")) as {
  todayIso: string;
  cases: { name: string; query: string; inputs: Record<string, number>; todayIso?: string }[];
};

const VOLATILE = new Set(["built_at", "snapshot_dir"]);
function strip(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(strip);
  if (x && typeof x === "object")
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, v]) => [k, strip(v)]),
    );
  return x;
}

for (const c of meta.cases) {
  const snapDir = path.join(goldenDir, "snapshots", c.name);
  const expFile = path.join(goldenDir, "expected", c.name + ".json");
  if (!fs.existsSync(snapDir) || !fs.existsSync(expFile)) {
    ok(`golden:${c.name}`, false, "нет снимка или эталона");
    continue;
  }
  try {
    const res = await build(c.query, c.inputs, {
      fromSnapshotDir: snapDir,
      todayIso: c.todayIso ?? meta.todayIso,
    });
    const expected = JSON.parse(fs.readFileSync(expFile, "utf8"));
    const a = JSON.stringify(strip(res));
    const b = JSON.stringify(strip(expected));
    if (a === b) ok(`golden:${c.name}`, true);
    else {
      // укажем первое расхождение для диагностики
      let i = 0;
      while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
      ok(`golden:${c.name}`, false, `расхождение у символа ${i}: …${a.slice(Math.max(0, i - 40), i + 40)}… ≠ …${b.slice(Math.max(0, i - 40), i + 40)}…`);
    }
  } catch (e) {
    ok(`golden:${c.name}`, false, String(e));
  }
}

/* 3. Паритет: пересчёт на странице (applyInputs по контракту) ≡ полная сборка движком с тем же вводом.
      Это и есть гарантия инвариантов 1 и 3: страница не считает «своё». */
const VARIANTS: Record<string, number | null>[] = [
  { position_size: 1_000_000 },
  { position_size: 5_000_000, k_pct: 0.3 },
  { position_size: 100_000, k_pct: 0.05 },
  { promised_pct: 30 },
  { promised_pct: null },
  { k_pct: 2.5, promised_pct: 12 },
];
for (const c of meta.cases) {
  const expFile = path.join(goldenDir, "expected", c.name + ".json");
  if (!fs.existsSync(expFile)) continue;
  const expected = JSON.parse(fs.readFileSync(expFile, "utf8"));
  if (expected.kind !== "report") continue;
  for (const v of VARIANTS) {
    const label = `parity:${c.name}:${JSON.stringify(v)}`;
    try {
      const client = BondReport.parse(applyInputs(expected.report, v as any));
      const server = await build(c.query, { ...c.inputs, ...v } as any, {
        fromSnapshotDir: path.join(goldenDir, "snapshots", c.name),
        todayIso: c.todayIso ?? meta.todayIso,
      });
      const a = JSON.stringify(strip(client));
      const b = JSON.stringify(strip(server.kind === "report" ? server.report : server));
      let i = 0;
      while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
      ok(label, a === b, a === b ? "" : `…${a.slice(Math.max(0, i - 60), i + 60)}… ≠ …${b.slice(Math.max(0, i - 60), i + 60)}…`);
    } catch (e) {
      ok(label, false, String(e));
    }
  }
}

console.log(failures === 0 ? `\nSELFTEST OK (${meta.cases.length} golden-кейсов + паритет страница ≡ движок)` : `\nSELFTEST FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
