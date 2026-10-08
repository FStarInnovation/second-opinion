/**
 * Пересборка эталонов golden из замороженных снимков с пополевым диффом.
 *   tsx src/golden-update.ts           — показать, что изменится (ничего не пишет)
 *   tsx src/golden-update.ts --write   — записать новые эталоны
 * Правило: эталон меняется только осознанно — дифф читается глазами до --write.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(here, "..", "golden");
const write = process.argv.includes("--write");
const meta = JSON.parse(fs.readFileSync(path.join(goldenDir, "cases.json"), "utf8")) as {
  todayIso: string; cases: { name: string; query: string; inputs: Record<string, number> }[];
};
const VOLATILE = new Set(["built_at", "snapshot_dir"]);

function diff(a: unknown, b: unknown, p: string, out: string[]) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) === !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) {
      if (VOLATILE.has(k)) continue;
      diff((a as any)[k], (b as any)[k], p ? `${p}.${k}` : k, out);
    }
    return;
  }
  const s = (x: unknown) => (x === undefined ? "∅" : JSON.stringify(x));
  out.push(`  ${p}: ${s(a).slice(0, 160)}\n      → ${s(b).slice(0, 160)}`);
}

for (const c of meta.cases) {
  const res = await build(c.query, c.inputs, {
    fromSnapshotDir: path.join(goldenDir, "snapshots", c.name),
    todayIso: meta.todayIso,
  });
  const file = path.join(goldenDir, "expected", c.name + ".json");
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
  const out: string[] = [];
  diff(old, res, "", out);
  console.log(out.length ? `${c.name}: ${out.length} изменений\n${out.join("\n")}` : `${c.name}: без изменений`);
  if (write && out.length) {
    // snapshot_dir — относительный путь, чтобы эталон не зависел от машины
    const rel = JSON.parse(JSON.stringify(res));
    if (rel.report?.diagnostics) rel.report.diagnostics.snapshot_dir = `golden/snapshots/${c.name}`;
    fs.writeFileSync(file, JSON.stringify(rel, null, 2) + "\n");
  }
}
if (write) console.log("\nЭталоны записаны.");
