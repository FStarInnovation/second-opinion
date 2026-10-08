/**
 * Журнал расхода: каждая запись `[chat]` дублируется в apps/web/.usage/usage.jsonl (в .gitignore),
 * чтобы считать стоимость после прогона, а не ловить строки в терминале. Ключей и текстов пользователя в журнале нет —
 * только провайдер, модель, токены, стоимость, имена инструментов и первые 80 символов реплики для привязки.
 * Если провайдер не вернул cost (Claude API, TypeSafe), стоимость считается по прайсу ниже.
 */
import fs from "node:fs";
import path from "node:path";

/** $ за 1M токенов (08.10.2026). Меняется — менять здесь и в проектном документе. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-haiku-5-5": { input: 0.10, output: 0.50, cacheRead: 0.01 },
  "anthropic/claude-haiku-5.5": { input: 0.10, output: 0.50, cacheRead: 0.01 },
  "openai/gpt-6-luna": { input: 0.10, output: 0.50, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "anthropic/claude-sonnet-5.5": { input: 2, output: 10, cacheRead: 0.2 },
  jev: { input: 0.042, output: 0, cacheRead: 0.042 },
};

export function priceFor(model: string | undefined) {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [k, v] of Object.entries(PRICES)) if (m.includes(k.toLowerCase().replace(/^anthropic\//, "").replace(/^openai\//, ""))) return v;
  return null;
}

export function estimateCost(model: string | undefined, input = 0, output = 0, cached = 0): number | null {
  const p = priceFor(model);
  if (!p) return null;
  return ((input - cached) * p.input + cached * p.cacheRead + output * p.output) / 1e6;
}

const DIR = process.env.SO_USAGE_DIR ?? path.join(process.cwd(), ".usage");
const FILE = path.join(DIR, "usage.jsonl");

export function appendUsage(rec: Record<string, unknown>) {
  if (process.env.SO_USAGE_LOG === "0") return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(rec) + "\n");
  } catch {
    /* журнал — best effort */
  }
}

export const usageFile = () => FILE;
