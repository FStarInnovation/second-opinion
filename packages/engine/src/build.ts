/**
 * build: запрос пользователя → распознавание → факты → контракт bond_report@1.
 * Единственная точка входа в движок (инвариант 1 плана): прямая форма,
 * инструменты ассистента и CLI вызывают именно её.
 * Результат — конверт BuildResult (zod): отчёт или ветки 2.3.0 «уточните выпуск» / «не нашли» / ошибка ввода.
 */
import { recognize } from "./recognize.js";
import { collectFacts } from "./iss/facts.js";
import { assembleReport, type BuildInputs } from "./report.js";
import { BuildResult, type BondReportT, type BuildResultT } from "./contract.js";
import type { FetchOptions } from "./iss/client.js";

export async function build(
  query: string,
  inputs: BuildInputs = {},
  opts: FetchOptions & { todayIso?: string } = {},
): Promise<BuildResultT> {
  const r = await recognize(query, opts);
  if (r.kind === "pick") return BuildResult.parse({ kind: "pick", query, note: r.note, candidates: r.candidates });
  if (r.kind === "notfound") return BuildResult.parse({ kind: "notfound", query, isinValid: r.isinValid });
  if (r.kind === "err") return BuildResult.parse({ kind: "err", query, msg: r.msg });
  const facts = await collectFacts(r.secid, opts);
  const report = assembleReport(facts, inputs, { snapshot_dir: opts.snapshotDir ?? opts.fromSnapshotDir ?? null });
  return { kind: "report", report };
}

export { collectFacts, assembleReport };
export type { BuildInputs, BondReportT, BuildResultT };
