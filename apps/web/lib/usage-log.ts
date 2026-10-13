/**
 * Журнал расхода и ответов: каждая запись `[chat]` дублируется в apps/web/.usage/usage.jsonl (в .gitignore),
 * чтобы считать стоимость и разбирать диалоги после прогона, а не ловить строки в терминале.
 * Что в журнале: провайдер, модель, токены, стоимость, имена инструментов; реплика пользователя — первые
 * USER_TEXT_LOG_CHARS (80) символов для привязки (запись gate); ответ ассистента — первые ANSWER_LOG_CHARS (500)
 * символов текста и имена инструментов (запись answer, и для ответов гейта, и для ответов модели).
 * Ответ может повторять запрос пользователя («Нашлось несколько выпусков по запросу «…»», цитата в ответе модели)
 * и содержать его сумму и комиссию — так что через запись answer в журнал попадает и часть текста пользователя сверх 80 символов.
 * Ключей и заголовков запросов в журнале нет. Если провайдер не вернул cost (Claude API, TypeSafe), стоимость — по прайсу ниже.
 */
import fs from "node:fs";
import path from "node:path";

/** Сколько символов реплики пользователя попадает в журнал (запись gate) */
export const USER_TEXT_LOG_CHARS = 80;
/** Сколько символов ответа ассистента попадает в журнал (запись answer) */
export const ANSWER_LOG_CHARS = 500;

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

/** input — все входные токены (включая прочитанные из кэша и записанные в него); запись в кэш у Anthropic стоит ×1,25 */
export function estimateCost(model: string | undefined, input = 0, output = 0, cached = 0, cacheWrite = 0): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const plain = Math.max(0, input - cached - cacheWrite);
  return (plain * p.input + cached * p.cacheRead + cacheWrite * p.input * 1.25 + output * p.output) / 1e6;
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
