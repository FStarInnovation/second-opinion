/**
 * WP-TG, TG.14 (синтетический кейс): обёртка над @so/engine/inputs ТОЛЬКО для дочернего процесса сценария misc.
 * scenarios.ts перенаправляет импорт "@so/engine/inputs" из apps/web/lib/engine.ts сюда (node:module.registerHooks).
 * Без флага globalThis.__soAuditTop3 обёртка ничего не меняет. С флагом — переставляет truth_score.top3 собранного отчёта,
 * чтобы порядок top3 ОТЛИЧАЛСЯ от сортировки сработавших флагов по баллам: так гейт, который берёт «Главные red flags»
 * из top3, отличим от гейта со своей сортировкой (на реальных golden оба порядка совпадают, проверка была бы тавтологией).
 * Код продукта не меняется; в процесс харнеса и в другие сценарии обёртка не попадает.
 */
import * as real from "@so/engine/inputs";

export * from "@so/engine/inputs";

type Permute = (ids: number[]) => number[];

export function applyInputs(...a: Parameters<typeof real.applyInputs>): ReturnType<typeof real.applyInputs> {
  const r = real.applyInputs(...a);
  const f = (globalThis as { __soAuditTop3?: Permute }).__soAuditTop3;
  if (f) r.truth_score.top3 = f([...r.truth_score.top3]);
  return r;
}
