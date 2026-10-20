/**
 * Инструменты ассистента — одобренный реестр (инвариант 2). Всё, что считает числа, идёт
 * через движок (buildCached → build(); applyInputs). Модель видит дайджест (toModelOutput),
 * блок в чате получает полный результат.
 */
import { tool } from "ai";
import { z } from "zod";
import { ReportInputsSchema, type ReportInputs } from "@so/engine/contract";
import type { ExplainResult, ReportToolResult } from "@so/present/protocol";
import { buildCached, rebuild } from "./engine";
import { digestResult } from "./digest";
import { findTerm, GLOSSARY } from "./glossary";
import { setResult, withPending, type ChatSession } from "./session";

/** Имена инструментов и формы их выходов — общий протокол сервера и клиентов (@so/present/protocol) */
export { TOOL_NAMES, type ToolName, type ReportToolResult, type ExplainResult } from "@so/present/protocol";

/** Ввод пользователя — единственная схема (@so/engine/contract): инструмент set_inputs, поле inputs тела /api/chat, параметры /chat?q=…
 *  (переход с /check) и deep-link бота, страница /check и /api/report. Тот же объект, не копия. */
export const inputsSchema = ReportInputsSchema;

export function makeTools(session: ChatSession) {
  const resolve_security = tool({
    description:
      "Распознать бумагу по вводу пользователя: ссылка, ISIN, SECID, регистрационный номер, номер программы или название. " +
      "Возвращает одну бумагу (и сразу её отчёт), список выпусков для выбора или «не найдена». Вызывай первым, когда пользователь называет бумагу.",
    inputSchema: z.object({ query: z.string().min(1).max(200).describe("Текст пользователя с идентификатором бумаги, как есть") }),
    execute: async ({ query }): Promise<ReportToolResult> => {
      // вводы со страницы /check (если отчёта в сессии ещё нет) — тот же отчёт, что и на странице
      const result = await buildCached(query, withPending(session));
      if (result.kind === "report") setResult(session, query, result);
      return { query, result };
    },
    toModelOutput: ({ output }) => ({ type: "json", value: digestResult(output.result) }),
  });

  const build_bond_report = tool({
    description:
      "Собрать базовый отчёт по облигации: доходность, цена и НКД, ликвидность, комиссии и налог, worst-case, red flags и Truth Score. " +
      "query — идентификатор бумаги (ISIN/SECID/название). inputs — то, что сказал пользователь: сумма, комиссия брокера, «сколько обещали».",
    inputSchema: z.object({ query: z.string().min(1).max(200), inputs: inputsSchema.optional() }),
    execute: async ({ query, inputs }): Promise<ReportToolResult> => {
      const result = await buildCached(query, withPending(session, (inputs ?? {}) as ReportInputs));
      if (result.kind === "report") setResult(session, query, result);
      return { query, result };
    },
    toModelOutput: ({ output }) => ({ type: "json", value: digestResult(output.result) }),
  });

  const set_inputs = tool({
    description:
      "Изменить ввод пользователя для уже собранного отчёта: сумму вложения, комиссию брокера, «сколько обещали» или цену предложения (если нет биржевой). " +
      "Пересчитывает ликвидность, комиссии, worst-case, флаг завышенной доходности и Truth Score. Требует, чтобы отчёт уже был собран.",
    inputSchema: inputsSchema,
    execute: async (inputs): Promise<ReportToolResult | { error: string }> => {
      if (!session.result || !session.query) return { error: "Отчёт ещё не собран — сначала назовите бумагу." };
      const result = await rebuild(session.query, session.result, inputs as ReportInputs);
      setResult(session, session.query, result);
      return { query: session.query, result };
    },
    toModelOutput: ({ output }) => ({ type: "json", value: "error" in output ? output : digestResult(output.result) }),
  });

  const explain_term = tool({
    description:
      "Объяснить термин из отчёта простыми словами по глоссарию: НКД, доходность к погашению, оферта, колл, флоатер, дюрация, G-спред, спред, амортизация, листинг, Truth Score, квал, worst-case, налог. Без чисел о бумаге.",
    inputSchema: z.object({ term: z.string().min(1).max(100) }),
    execute: async ({ term }): Promise<ExplainResult> => {
      const t = findTerm(term);
      return t ? { found: true, id: t.id, title: t.title, text: t.text } : { found: false, query: term, known: GLOSSARY.map((g) => g.title) };
    },
  });

  return { resolve_security, build_bond_report, set_inputs, explain_term };
}

export type Tools = ReturnType<typeof makeTools>;
