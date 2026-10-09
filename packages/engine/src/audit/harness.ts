/**
 * Аудит-харнес движка. Запуск из корня репо: `npm run -w @so/engine audit [-- --only B --baseline --json]`.
 *
 *   (без флагов)        все проверки; exit 1 при любом RED/ERROR (режим CI после правок)
 *   --only A,B          только пакеты работ A и B (или id через запятую: B.1,B.2)
 *   --baseline          сравнить с audit/baseline.json: exit 1 только если статус ХУЖЕ базового;
 *                       перевороты RED→GREEN печатаются как прогресс
 *   --write-baseline    записать текущие статусы в audit/baseline.json
 *   --json              машинный вывод (массив результатов) в stdout
 *   AUDIT_LIVE=1        выполнять kind:"live" (иначе SKIP)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE, type Check, type Status } from "./lib";
import { checks as A } from "./checks/wp-a";
import { checks as B } from "./checks/wp-b";
import { checks as C } from "./checks/wp-c";
import { checks as D } from "./checks/wp-d";
import { checks as F } from "./checks/wp-f";
import { checks as G } from "./checks/wp-g";
import { checks as R } from "./checks/wp-r";
import { checks as T } from "./checks/wp-t";

const ALL: Check[] = [...A, ...B, ...C, ...D, ...F, ...G, ...R, ...T];

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(here, "baseline.json");

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const only = opt("--only")?.split(",").map((s) => s.trim()).filter(Boolean);

interface Result { id: string; wp: string; kind: string; guard: boolean; status: Status; title: string; detail: string; ms: number }

const RANK: Record<Status, number> = { GREEN: 0, SKIP: 0, RED: 1, ERROR: 2 };

async function runOne(c: Check): Promise<Result> {
  const base = { id: c.id, wp: c.wp, kind: c.kind, guard: !!c.guard, title: c.title };
  if (c.kind === "live" && !LIVE) return { ...base, status: "SKIP", detail: "live: нужен AUDIT_LIVE=1", ms: 0 };
  const t0 = Date.now();
  try {
    const v = await c.run();
    return { ...base, status: v.pass ? "GREEN" : "RED", detail: v.detail, ms: Date.now() - t0 };
  } catch (e) {
    return { ...base, status: "ERROR", detail: String(e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" | ") ?? e.message : e), ms: Date.now() - t0 };
  }
}

const selected = ALL.filter((c) => !only || only.includes(c.wp) || only.includes(c.id));
const dupes = selected.map((c) => c.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dupes.length) { console.error(`дубли id: ${[...new Set(dupes)].join(", ")}`); process.exit(2); }

const results: Result[] = [];
for (const c of selected) {
  const r = await runOne(c);
  results.push(r);
  if (!flag("--json")) console.error(`${r.status.padEnd(5)} ${r.id.padEnd(6)} ${r.title}`);
}

if (flag("--json")) {
  console.log(JSON.stringify(results, null, 1));
} else {
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  console.log("\n" + ["ID", "WP", "kind", "status", "title"].map((h, i) => pad(h, [7, 3, 8, 6, 70][i])).join(" "));
  for (const r of results) {
    console.log([pad(r.id, 7), pad(r.wp, 3), pad(r.kind, 8), pad(r.status + (r.guard ? "*" : ""), 6), pad(r.title, 70)].join(" "));
    if (r.status !== "GREEN" && r.status !== "SKIP") console.log("        └ " + r.detail.replace(/\s+/g, " ").slice(0, 400));
  }
  const cnt = (s: Status) => results.filter((r) => r.status === s).length;
  console.log(`\nИтого: GREEN ${cnt("GREEN")} · RED ${cnt("RED")} · ERROR ${cnt("ERROR")} · SKIP ${cnt("SKIP")}  (${results.length} проверок${only ? ", фильтр " + only.join(",") : ""}; * = guard)`);
  const guardsRed = results.filter((r) => r.guard && r.status !== "GREEN" && r.status !== "SKIP");
  if (guardsRed.length) console.log(`⚠ guard-инварианты не GREEN: ${guardsRed.map((r) => r.id).join(", ")} — регрессия или дефект харнеса`);
}

if (flag("--write-baseline")) {
  const prev = fs.existsSync(BASELINE) ? (JSON.parse(fs.readFileSync(BASELINE, "utf8")) as Record<string, Status>) : {};
  for (const r of results) prev[r.id] = r.status;
  fs.writeFileSync(BASELINE, JSON.stringify(prev, null, 1) + "\n");
  console.error(`baseline записан: ${BASELINE} (${Object.keys(prev).length} id)`);
}

let exitCode = 0;
if (flag("--baseline")) {
  if (!fs.existsSync(BASELINE)) { console.error("нет baseline.json — сначала --write-baseline"); process.exit(2); }
  const base = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as Record<string, Status>;
  const worse = results.filter((r) => r.id in base && RANK[r.status] > RANK[base[r.id]]);
  const better = results.filter((r) => r.id in base && RANK[r.status] < RANK[base[r.id]]);
  const fresh = results.filter((r) => !(r.id in base));
  if (!flag("--json")) {
    if (better.length) console.log(`↑ стало лучше: ${better.map((r) => `${r.id} ${base[r.id]}→${r.status}`).join(", ")}`);
    if (fresh.length) console.log(`новые (нет в baseline): ${fresh.map((r) => r.id).join(", ")}`);
    if (worse.length) console.log(`↓ ХУЖЕ базового: ${worse.map((r) => `${r.id} ${base[r.id]}→${r.status}`).join(", ")}`);
  }
  exitCode = worse.length ? 1 : 0;
} else {
  exitCode = results.some((r) => r.status === "RED" || r.status === "ERROR") ? 1 : 0;
}
process.exit(exitCode);
