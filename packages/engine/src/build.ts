/**
 * build: запрос пользователя → распознавание → факты → контракт bond_report@1.
 * Единственная точка входа в движок (инвариант 1 плана): прямая форма,
 * инструменты ассистента и CLI вызывают именно её.
 */
import { recognize, type Recognized } from "./recognize.js";
import { collectFacts } from "./iss/facts.js";
import { assembleReport, type BuildInputs } from "./report.js";
import type { BondReportT } from "./contract.js";
import type { FetchOptions } from "./iss/client.js";

export type BuildResult =
  | { kind: "report"; report: BondReportT }
  | Exclude<Recognized, { kind: "bond" }>;

export async function build(
  query: string,
  inputs: BuildInputs = {},
  opts: FetchOptions & { todayIso?: string } = {},
): Promise<BuildResult> {
  const r = await recognize(query, opts);
  if (r.kind !== "bond") return r;
  const facts = await collectFacts(r.secid, opts);
  const report = assembleReport(facts, inputs, { snapshot_dir: opts.snapshotDir ?? opts.fromSnapshotDir ?? null });
  return { kind: "report", report };
}

export { collectFacts, assembleReport };
export type { BuildInputs, BondReportT };
