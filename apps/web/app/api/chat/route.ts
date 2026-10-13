/**
 * Маршрут чата. Порядок: лимит сообщений → Jev-гейт (уверенные реплики — инструмент без LLM)
 * → модель с одобренным реестром инструментов. Usage каждого вызова пишется в лог и в сессию.
 * Поле тела inputs — вводы со страницы /check (переход «отчёт → ассистент»): к первому отчёту сессии.
 */
import {
  convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText, type UIMessage,
} from "ai";
import { chatModel, isMock, provider, modelLabel, callProviderOptions } from "@/lib/model";
import { inputsSchema, makeTools } from "@/lib/tools";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { getSession, MESSAGE_LIMIT } from "@/lib/session";
import { runGate } from "@/lib/gate";
import { jevProvider } from "@/lib/jev";
import { appendUsage, estimateCost, ANSWER_LOG_CHARS, USER_TEXT_LOG_CHARS } from "@/lib/usage-log";
import { budgetState, countMessage, spend, BUDGET_EXHAUSTED_TEXT } from "@/lib/budget";
import type { ReportInputs } from "@so/engine/contract";

export const maxDuration = 60;

const textOf = (m: UIMessage | undefined) =>
  m ? m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ").trim() : "";

export async function POST(req: Request) {
  const body = (await req.json()) as { messages: UIMessage[]; id?: string; inputs?: unknown };
  const messages = body.messages ?? [];
  const session = getSession(body.id ?? req.headers.get("x-so-chat") ?? "anon");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const text = textOf(lastUser);

  session.userMessages += 1;
  const plainReply = (delta: string) =>
    createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: ({ writer }) => {
          const id = "lim";
          writer.write({ type: "text-start", id });
          writer.write({ type: "text-delta", id, delta });
          writer.write({ type: "text-end", id });
        },
      }),
    });
  if (session.userMessages > MESSAGE_LIMIT)
    return plainReply(`В этой сессии лимит ${MESSAGE_LIMIT} сообщений исчерпан. Обновите страницу, чтобы начать новую проверку.`);
  const budget = budgetState();
  if (budget.exhausted) {
    log({ chat: session.id, step: "budget", spent: Math.round(budget.spent * 1e4) / 1e4, limit: budget.limit });
    return plainReply(BUDGET_EXHAUSTED_TEXT);
  }
  countMessage();

  // Вводы /check — недоверенный ввод: только схема set_inputs; невалидное игнорируется (не 400 — это не ошибка пользователя).
  // Принимаются, пока отчёта в сессии нет; применяются один раз — при первой сборке отчёта (gate/tools → withPending)
  if (session.result == null && body.inputs != null) {
    const parsed = inputsSchema.partial().safeParse(body.inputs);
    if (parsed.success && Object.keys(parsed.data).length) session.pendingInputs = parsed.data as ReportInputs;
  }

  const tools = makeTools(session);
  let answeredBy: "gate" | "model" | null = null; // кто отвечал на реплику — для записи answer в журнале
  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: async ({ writer }) => {
      /* 1. Jev-гейт */
      const gate = text ? await runGate(writer, session, text, textOf(lastAssistant) || null) : { handled: false, decision: null };
      const jevIn = gate.decision?.usage?.inputTokens;
      if (gate.decision?.source === "jev") spend(gate.decision.usage?.cost ?? estimateCost("jev", jevIn ?? 0) ?? 0);
      log({
        chat: session.id, step: "gate", text: text.slice(0, USER_TEXT_LOG_CHARS),
        ...(gate.decision ? { intent: gate.decision.intent, confidence: gate.decision.confidence, source: gate.decision.source } : {}),
        handled: gate.handled,
        ...(gate.decision?.source === "jev" ? { jev_in: jevIn, jev_cost: gate.decision.usage?.cost ?? estimateCost("jev", jevIn ?? 0) } : {}),
        ...(gate.decision?.jevError ? { jev_error: gate.decision.jevError } : {}),
      });
      if (gate.handled) {
        answeredBy = "gate";
        return;
      }

      /* 2. Модель с инструментами */
      answeredBy = "model";
      // Системный промпт с cache-breakpoint (ai 7: instructions вместо system): Claude API кэширует префикс
      // «инструменты + система» (~2,7k токенов), повторные вызовы платят за него 10%. OpenRouter/mock ключ игнорируют.
      const result = streamText({
        model: chatModel(),
        instructions: { role: "system", content: SYSTEM_PROMPT, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
        messages: await convertToModelMessages(messages, { tools }),
        tools,
        stopWhen: stepCountIs(4),
        providerOptions: callProviderOptions(),
        onStepFinish: ({ usage, response, toolCalls, providerMetadata }) => {
          const or = (providerMetadata as { openrouter?: { usage?: { cost?: number; promptTokensDetails?: { cachedTokens?: number } } } } | undefined)?.openrouter;
          const model = response.modelId ?? modelLabel();
          const cached = usage.inputTokenDetails?.cacheReadTokens ?? or?.usage?.promptTokensDetails?.cachedTokens ?? 0;
          // cache_write > 0 — breakpoint сработал и префикс записан в кэш (читается следующими вызовами 5 минут)
          const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
          // OpenRouter отдаёт cost сам; Claude API — считаем по прайсу (запись в кэш ×1,25)
          const cost = or?.usage?.cost ?? estimateCost(model, usage.inputTokens ?? 0, usage.outputTokens ?? 0, cached, cacheWrite) ?? 0;
          session.usage.calls += 1;
          session.usage.input += usage.inputTokens ?? 0;
          session.usage.output += usage.outputTokens ?? 0;
          session.usage.cost += cost;
          spend(cost);
          log({
            chat: session.id, step: "llm", provider: provider(), model,
            in: usage.inputTokens, cached, cache_write: cacheWrite, out: usage.outputTokens, cost: Math.round(cost * 1e6) / 1e6,
            cost_source: or?.usage?.cost != null ? "provider" : "price-list",
            tools: toolCalls.map((t) => t.toolName),
          });
        },
      });
      writer.merge(result.toUIMessageStream({ sendStart: false }));
    },
    onError: (e) => {
      log({ step: "error", error: String(e).slice(0, 300) });
      return "Не получилось ответить — попробуйте ещё раз или переформулируйте запрос.";
    },
    // Что увидел пользователь — и от гейта, и от модели: начало текста ответа и имена инструментов. Ключей и заголовков здесь нет;
    // в тексте ответа бывают сумма и комиссия пользователя и повтор его запроса (см. шапку lib/usage-log.ts)
    onEnd: ({ responseMessage, isAborted }) => {
      log({ chat: session.id, step: "answer", by: answeredBy ?? "none", ...answerOf(responseMessage), ...(isAborted ? { aborted: true } : {}) });
    },
  });
  // Диагностические заголовки — только при разработке и в MOCK: на проде имена провайдеров наружу не уходят
  const headers: Record<string, string> =
    process.env.NODE_ENV !== "production" ? { "x-so-mode": isMock() ? "mock" : provider(), "x-so-jev": jevProvider() ?? "rules" }
    : isMock() ? { "x-so-mode": "mock" }
    : {};
  return createUIMessageStreamResponse({ stream, headers });
}

/** Ответ ассистента для журнала: текст подряд (первые ANSWER_LOG_CHARS символов) и инструменты в порядке вызова */
function answerOf(m: UIMessage | undefined): { text: string; tools: string[] } {
  const parts = m?.parts ?? [];
  const text = parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ").replace(/\s+/g, " ").trim();
  const tools = parts.flatMap((p) =>
    p.type === "dynamic-tool" ? [(p as { toolName: string }).toolName] : p.type.startsWith("tool-") ? [p.type.slice("tool-".length)] : []);
  return { text: text.slice(0, ANSWER_LOG_CHARS), tools };
}

function log(rec: Record<string, unknown>) {
  const full = { t: new Date().toISOString(), ...rec };
  appendUsage(full);
  if (process.env.SO_QUIET === "1") return;
  console.log("[chat]", JSON.stringify(full));
}
