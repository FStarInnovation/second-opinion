/**
 * Сводка расхода по журналу .usage/usage.jsonl: сколько реплик, сколько ушло в LLM, сколько решил Jev,
 * токены и стоимость по провайдерам, стоимость на реплику и экстраполяция на 1000 сообщений; разрез по каналу (сайт / Telegram-бот —
 * поле channel записей маршрута чата; записи до WP-TG без поля — сайт).
 *   npx tsx scripts/usage-report.ts [--file .usage/usage.jsonl] [--since 2026-10-08T00:00]
 */
import fs from "node:fs";
import path from "node:path";
import { estimateCost } from "../lib/usage-log";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const file = path.resolve(arg("--file") ?? path.join(process.cwd(), ".usage/usage.jsonl"));
const since = arg("--since") ? Date.parse(arg("--since")!) : 0;
if (!fs.existsSync(file)) { console.error(`Журнала нет: ${file}. Он появляется после первых реплик в чате.`); process.exit(2); }

type Rec = { t: string; chat?: string; channel?: string; step: string; text?: string; intent?: string; confidence?: number; source?: string; handled?: boolean;
  provider?: string; model?: string; in?: number; cached?: number; cache_write?: number; out?: number; cost?: number; cost_source?: string; tools?: string[];
  jev_in?: number; jev_cost?: number; jev_calls?: number; error?: string };
const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec).filter((r) => Date.parse(r.t) >= since);

const gates = rows.filter((r) => r.step === "gate");
const llm = rows.filter((r) => r.step === "llm");
const errors = rows.filter((r) => r.step === "error");
const byJev = gates.filter((r) => r.source === "jev");
const handled = gates.filter((r) => r.handled);
const sessions = new Set(gates.map((r) => r.chat)).size;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const llmIn = sum(llm.map((r) => r.in ?? 0)), llmCached = sum(llm.map((r) => r.cached ?? 0)), llmOut = sum(llm.map((r) => r.out ?? 0));
const llmCacheWrite = sum(llm.map((r) => r.cache_write ?? 0));
const llmCostOf = (xs: Rec[]) => sum(xs.map((r) => r.cost ?? estimateCost(r.model, r.in ?? 0, r.out ?? 0, r.cached ?? 0, r.cache_write ?? 0) ?? 0));
// Jev — все вызовы реплики (маршрут и разбор вводов) в записи gate: jev_in / jev_cost / jev_calls; в старых записях — только при source jev
const jevRecs = (xs: Rec[]) => xs.filter((r) => r.jev_in != null || r.jev_cost != null);
const jevCostOf = (xs: Rec[]) => sum(jevRecs(xs).map((r) => r.jev_cost ?? estimateCost("jev", r.jev_in ?? 0) ?? 0));
const llmCost = llmCostOf(llm);
const jevIn = sum(jevRecs(gates).map((r) => r.jev_in ?? 0));
const jevCalls = sum(jevRecs(gates).map((r) => r.jev_calls ?? 1));
const jevCost = jevCostOf(gates);
const total = llmCost + jevCost;
const msgs = gates.length;
const perMsg = msgs ? total / msgs : 0;
const fmt$ = (x: number) => "$" + x.toFixed(x < 0.01 ? 5 : 4);

const byModel = new Map<string, { calls: number; in: number; out: number; cost: number }>();
for (const r of llm) {
  const k = `${r.provider ?? "?"} · ${r.model ?? "?"}`;
  const m = byModel.get(k) ?? { calls: 0, in: 0, out: 0, cost: 0 };
  m.calls++; m.in += r.in ?? 0; m.out += r.out ?? 0; m.cost += r.cost ?? 0; byModel.set(k, m);
}
const intents = new Map<string, number>();
for (const r of gates) intents.set(`${r.intent ?? "?"}${r.handled ? " (без LLM)" : " → LLM"}`, (intents.get(`${r.intent ?? "?"}${r.handled ? " (без LLM)" : " → LLM"}`) ?? 0) + 1);

console.log(`Журнал: ${file}\nПериод: ${rows[0]?.t.slice(0, 16)} … ${rows.at(-1)?.t.slice(0, 16)}\n`);
console.log(`Реплик пользователя: ${msgs} в ${sessions} сессиях; решено без LLM: ${handled.length} (${msgs ? Math.round((handled.length / msgs) * 100) : 0}%); маршрутизировал Jev: ${byJev.length}, правила: ${gates.length - byJev.length}`);
console.log(`Вызовов модели: ${llm.length} (${msgs ? (llm.length / Math.max(1, msgs - handled.length)).toFixed(2) : 0} на реплику с LLM); ошибок: ${errors.length}`);
console.log(`\nТокены LLM: вход ${llmIn.toLocaleString("ru-RU")} (из кэша ${llmCached.toLocaleString("ru-RU")}, записано в кэш ${llmCacheWrite.toLocaleString("ru-RU")}), выход ${llmOut.toLocaleString("ru-RU")}`);
for (const [k, m] of byModel) console.log(`  ${k}: ${m.calls} вызовов, вход ${m.in.toLocaleString("ru-RU")}, выход ${m.out.toLocaleString("ru-RU")}, ${fmt$(m.cost)}`);
console.log(`Токены Jev: вход ${jevIn.toLocaleString("ru-RU")} за ${jevCalls} вызовов`);
console.log(`\nСтоимость: LLM ${fmt$(llmCost)} + Jev ${fmt$(jevCost)} = ${fmt$(total)}  (${llm.some((r) => r.cost_source === "price-list") ? "LLM по прайс-листу, провайдер cost не отдаёт" : "cost от провайдера"})`);
console.log(`На реплику: ${fmt$(perMsg)} → на 1000 сообщений ≈ $${(perMsg * 1000).toFixed(2)}; на реплику с LLM: ${fmt$(llm.length ? llmCost / Math.max(1, msgs - handled.length) : 0)}`);

/* Разрез по каналу: сайт и Telegram-бот делят один бюджет и один журнал */
const channelOfRec = (r: Rec) => r.channel ?? "web";
const channels = [...new Set(rows.map(channelOfRec))].sort((a, b) => (a === "web" ? -1 : b === "web" ? 1 : a.localeCompare(b)));
console.log(`\nПо каналам:`);
for (const c of channels) {
  const cr = rows.filter((r) => channelOfRec(r) === c);
  const g = cr.filter((r) => r.step === "gate"), l = cr.filter((r) => r.step === "llm");
  const cost = llmCostOf(l) + jevCostOf(g);
  const refused = cr.filter((r) => r.step === "budget").length;
  console.log(`  ${c}: реплик ${g.length} в ${new Set(g.map((r) => r.chat)).size} сессиях, без LLM ${g.filter((r) => r.handled).length}, ` +
    `вызовов модели ${l.length}, стоимость ${fmt$(cost)} (на реплику ${fmt$(g.length ? cost / g.length : 0)})` +
    `${refused ? `, отказов по бюджету ${refused}` : ""}, ошибок ${cr.filter((r) => r.step === "error").length}`);
}

console.log(`\nНамерения:`);
for (const [k, n] of [...intents].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
const uncertain = gates.filter((r) => r.source === "jev" && (r.confidence ?? 0) < 0.8);
if (uncertain.length) { console.log(`\nJev не уверен (<0,8) — ушло модели:`); for (const r of uncertain.slice(0, 15)) console.log(`  ${(r.confidence ?? 0).toFixed(2)}  ${r.intent?.padEnd(16)} «${r.text}»`); }
if (errors.length) { console.log(`\nОшибки:`); for (const r of errors.slice(0, 10)) console.log(`  ${r.t.slice(11, 19)} ${r.error}`); }
