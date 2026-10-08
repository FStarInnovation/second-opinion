/**
 * CLI: tsx src/cli.ts "<запрос>" [--pos 500000] [--k 0.3] [--promised 26]
 *      [--price 98.5] [--snapshot-dir dir] [--from-snapshots dir] [--today YYYY-MM-DD]
 *      [--out file.json] [--quiet]
 */
import fs from "node:fs";
import { build } from "./build";
import { fmt, pctS } from "./metrics";

function arg(name: string): string | null {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? process.argv[i + 1] ?? null : null;
}
const has = (name: string) => process.argv.includes("--" + name);

const query = process.argv[2];
if (!query || query.startsWith("--")) {
  console.error('Использование: tsx src/cli.ts "<запрос>" [--pos N] [--k X] [--promised Y] [--price P] [--snapshot-dir D | --from-snapshots D] [--today YYYY-MM-DD] [--out F]');
  process.exit(2);
}

const num = (s: string | null) => (s == null ? null : parseFloat(s.replace(",", ".")));

const res = await build(
  query,
  {
    position_size: num(arg("pos")) ?? undefined,
    k_pct: num(arg("k")),
    promised_pct: num(arg("promised")),
    offer_price_pct: num(arg("price")),
  },
  {
    snapshotDir: arg("snapshot-dir") ?? undefined,
    fromSnapshotDir: arg("from-snapshots") ?? undefined,
    todayIso: arg("today") ?? undefined,
  },
);

const out = arg("out");
if (out) fs.writeFileSync(out, JSON.stringify(res, null, 2));

if (res.kind !== "report") {
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}
const r = res.report;
if (!has("quiet")) {
  const y = r.yield;
  console.log(`▸ ${r.security.shortname} (${r.security.secid})  статус: ${r.status.kind}`);
  console.log(`  ${r.product.plain_text}`);
  if (y.line) console.log(`  Доходность: ${y.line}`);
  console.log(`  Биржа: ${pctS(y.exchange.pct)} от ${y.exchange.price_pct ?? "—"}% (${y.exchange.datetype ?? "—"}) · свой контроль: ${pctS(y.own_control_pct)} · Δ ${y.control_diff_pp == null ? "—" : fmt(y.control_diff_pp, 2) + " п.п."}`);
  if (r.price.line) console.log(`  ${r.price.line}`);
  console.log(`  Ликвидность: ${r.liquidity.line}`);
  console.log(`  Налог/комиссия: ${r.fees_tax.line}`);
  if (r.claim.line) console.log(`  ${r.claim.line}`);
  console.log(`  Truth Score: ${r.truth_score.score} — ${r.truth_score.grade}; флаги: ${r.flags.filter((f) => f.fired).map((f) => `#${f.id} ${f.title} (−${f.points})`).join("; ") || "нет"}`);
  console.log(`  Panels: ${r.panels.join(" → ")}`);
  if (r.diagnostics.warnings.length) console.log(`  ⚠ ${r.diagnostics.warnings.join(" | ")}`);
  if (out) console.log(`  JSON: ${out}`);
}
