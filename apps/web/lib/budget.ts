/**
 * Дневной лимит расхода на модели (Haiku + Jev) для открытого тестового стенда.
 * Суммируется стоимость из журнала за календарный день (по МСК) и хранится в .usage/budget.json,
 * чтобы пережить перезапуск. При исчерпании /api/chat отвечает текстом без обращения к моделям;
 * прямой путь (/check, /api/report) не тратит ничего и работает всегда.
 * SO_DAILY_BUDGET_USD — лимит в долларах (по умолчанию 2); 0 — без лимита.
 */
import fs from "node:fs";
import path from "node:path";
import { budgetExhaustedText } from "@so/present/copy";

const DIR = process.env.SO_USAGE_DIR ?? path.join(process.cwd(), ".usage");
const FILE = path.join(DIR, "budget.json");
export const DAILY_BUDGET_USD = Number(process.env.SO_DAILY_BUDGET_USD ?? 2);

interface Budget { day: string; spent: number; messages: number }

/** Календарный день в Москве (UTC+3) — стенд для российской аудитории, сутки считаем по МСК */
export const mskDay = (d = new Date()) => new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);

let cache: Budget | null = null;

/** Файл читается при каждом обращении (один маленький JSON на сообщение): ручной сброс —
 *  удалить .usage/budget.json — подхватывается без перезапуска. Кэш только на случай ошибки чтения. */
function load(): Budget {
  const day = mskDay();
  try {
    const b = JSON.parse(fs.readFileSync(FILE, "utf8")) as Budget;
    cache = b.day === day ? b : { day, spent: 0, messages: 0 };
  } catch {
    cache = cache && cache.day === day ? cache : { day, spent: 0, messages: 0 };
  }
  return cache;
}

function save(b: Budget) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(b));
  } catch {
    /* best effort */
  }
}

/** Учесть стоимость одного вызова (модели или Jev) */
export function spend(usd: number) {
  const b = load();
  b.spent += usd;
  save(b);
}

export function countMessage() {
  const b = load();
  b.messages += 1;
  save(b);
}

export function budgetState() {
  const b = load();
  const exhausted = DAILY_BUDGET_USD > 0 && b.spent >= DAILY_BUDGET_USD;
  return { ...b, limit: DAILY_BUDGET_USD, exhausted };
}

/** Отказ сайта при исчерпанном бюджете; текст — из @so/present/copy (у Telegram свой, маршрут выбирает по каналу) */
export const BUDGET_EXHAUSTED_TEXT = budgetExhaustedText("web");
