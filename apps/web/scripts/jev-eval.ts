/**
 * Оценка маршрутизатора на размеченных фразах: правила (без ключа) и Jev (с OPENROUTER_API_KEY в .env).
 *   npx tsx scripts/jev-eval.ts            — правила
 *   npx tsx scripts/jev-eval.ts --jev      — живой Jev (ключ из окружения), печатает долю уверенных и ошибки
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeByRules, routeMessage, jevThreshold, jevProvider } from "../lib/jev";
import { estimateCost } from "../lib/usage-log";

const here = path.dirname(fileURLToPath(import.meta.url));
const rows = fs.readFileSync(path.join(here, "../jev/router-phrases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { text: string; report_shown: boolean; intent: string; ambiguous?: boolean });
const live = process.argv.includes("--jev");
if (live && !jevProvider()) { console.error("Нет ключа Jev: задай TYPESAFE_API_KEY или OPENROUTER_API_KEY в apps/web/.env (загрузка: npx tsx --env-file=.env scripts/jev-eval.ts --jev)"); process.exit(2); }

let ok = 0, sure = 0, sureOk = 0, cost = 0, tokens = 0;
const errs: string[] = [];
for (const r of rows) {
  const d = live ? await routeMessage(r.text, r.report_shown) : routeByRules(r.text, r.report_shown);
  tokens += d.usage?.inputTokens ?? 0;
  cost += d.usage?.cost ?? estimateCost("jev", d.usage?.inputTokens ?? 0) ?? 0; // TypeSafe не возвращает cost — считаем по прайсу
  const hit = d.intent === r.intent;
  if (hit) ok++;
  const isSure = d.confidence >= jevThreshold();
  if (r.ambiguous) { // голое число: правильный ответ — НЕ быть уверенным
    if (isSure) errs.push(`УВЕРЕННО НА ДВУСМЫСЛЕННОМ ${d.intent.padEnd(16)} (${d.confidence.toFixed(2)}) «${r.text}» — ожидали уход к модели`);
    continue;
  }
  if (isSure) { sure++; if (hit) sureOk++; else errs.push(`УВЕРЕННО НЕВЕРНО  ${d.intent.padEnd(16)} (${d.confidence.toFixed(2)}) ← ожидали ${r.intent.padEnd(16)} «${r.text}»`); }
  else if (!hit) errs.push(`неуверенно        ${d.intent.padEnd(16)} (${d.confidence.toFixed(2)}) ← ожидали ${r.intent.padEnd(16)} «${r.text}»`);
}
console.log(`${live ? `Jev (${jevProvider()})` : "Правила"}: совпадений ${ok}/${rows.length}; уверенных (≥${jevThreshold()}) ${sure}/${rows.length}, из них верных ${sureOk}${live ? `; ${tokens} входных токенов, стоимость $${cost.toFixed(5)}` : ""}`);
for (const e of errs) console.log("  " + e);
process.exit(errs.some((e) => e.startsWith("УВЕРЕННО")) ? 1 : 0);
// критерий: уверенные ошибки = 0; неуверенные расхождения допустимы — их разбирает модель
