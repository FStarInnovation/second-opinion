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
import { build } from "./build.js";
import { shift, solve, termPhrase } from "./metrics.js";

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

/* 2. Golden-кейсы из снимков */
const meta = JSON.parse(fs.readFileSync(path.join(goldenDir, "cases.json"), "utf8")) as {
  todayIso: string;
  cases: { name: string; query: string; inputs: Record<string, number> }[];
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
      todayIso: meta.todayIso,
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

console.log(failures === 0 ? `\nSELFTEST OK (${meta.cases.length} golden-кейсов)` : `\nSELFTEST FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
