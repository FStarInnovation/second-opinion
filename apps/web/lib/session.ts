/**
 * Состояние чата на сервере: последний отчёт (для set_inputs без повторного похода в ISS)
 * и счётчик реплик (лимит на сессию — защита от злоупотреблений и потолок стоимости).
 * In-memory: демо-режим без хостинга; для прода — Redis с тем же интерфейсом.
 */
import type { BuildResultT } from "@so/engine/contract";

export interface ChatSession {
  id: string;
  query: string | null;      // запрос, по которому собран текущий отчёт
  result: BuildResultT | null;
  userMessages: number;
  usage: { input: number; output: number; cost: number; calls: number; jev: number };
  touched: number;
}

const sessions = new Map<string, ChatSession>();
const TTL_MS = 60 * 60_000;
export const MESSAGE_LIMIT = Number(process.env.SO_MESSAGE_LIMIT ?? 20);

export function getSession(id: string): ChatSession {
  for (const [k, s] of sessions) if (Date.now() - s.touched > TTL_MS) sessions.delete(k);
  let s = sessions.get(id);
  if (!s) {
    s = { id, query: null, result: null, userMessages: 0, usage: { input: 0, output: 0, cost: 0, calls: 0, jev: 0 }, touched: Date.now() };
    sessions.set(id, s);
  }
  s.touched = Date.now();
  return s;
}

export function setResult(s: ChatSession, query: string, result: BuildResultT) {
  s.query = query;
  s.result = result;
}
