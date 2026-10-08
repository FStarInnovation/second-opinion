/**
 * Маршрут чата. Порядок: лимит сообщений → Jev-гейт (уверенные реплики — инструмент без LLM)
 * → модель с одобренным реестром инструментов. Usage каждого вызова пишется в лог и в сессию.
 */
import {
  convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText, type UIMessage,
} from "ai";
import { chatModel, isMock, provider, modelLabel, callProviderOptions } from "@/lib/model";
import { makeTools } from "@/lib/tools";
import { SYSTEM_PROMPT } from "@/lib/prompt";
import { getSession, MESSAGE_LIMIT } from "@/lib/session";
import { runGate } from "@/lib/gate";
import { jevEnabled } from "@/lib/jev";

export const maxDuration = 60;

const textOf = (m: UIMessage | undefined) =>
  m ? m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ").trim() : "";

export async function POST(req: Request) {
  const body = (await req.json()) as { messages: UIMessage[]; id?: string };
  const messages = body.messages ?? [];
  const session = getSession(body.id ?? req.headers.get("x-so-chat") ?? "anon");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const text = textOf(lastUser);

  session.userMessages += 1;
  if (session.userMessages > MESSAGE_LIMIT) {
    const stream = createUIMessageStream({
      execute: ({ writer }) => {
        const id = "lim";
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: `В этой сессии лимит ${MESSAGE_LIMIT} сообщений исчерпан. Обновите страницу, чтобы начать новую проверку.` });
        writer.write({ type: "text-end", id });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  const tools = makeTools(session);
  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: async ({ writer }) => {
      /* 1. Jev-гейт */
      const gate = text ? await runGate(writer, session, text, textOf(lastAssistant) || null) : { handled: false, decision: null };
      log({ chat: session.id, step: "gate", text: text.slice(0, 80), ...(gate.decision ? { intent: gate.decision.intent, confidence: gate.decision.confidence, source: gate.decision.source } : {}), handled: gate.handled });
      if (gate.handled) return;

      /* 2. Модель с инструментами */
      const result = streamText({
        model: chatModel(),
        system: SYSTEM_PROMPT,
        messages: await convertToModelMessages(messages, { tools }),
        tools,
        stopWhen: stepCountIs(4),
        providerOptions: callProviderOptions(),
        onStepFinish: ({ usage, response, toolCalls, providerMetadata }) => {
          const or = (providerMetadata as { openrouter?: { usage?: { cost?: number; promptTokensDetails?: { cachedTokens?: number } } } } | undefined)?.openrouter;
          session.usage.calls += 1;
          session.usage.input += usage.inputTokens ?? 0;
          session.usage.output += usage.outputTokens ?? 0;
          session.usage.cost += or?.usage?.cost ?? 0;
          log({
            chat: session.id, step: "llm", provider: provider(), model: response.modelId ?? modelLabel(),
            in: usage.inputTokens, cached: usage.inputTokenDetails?.cacheReadTokens ?? or?.usage?.promptTokensDetails?.cachedTokens, out: usage.outputTokens,
            cost: or?.usage?.cost, tools: toolCalls.map((t) => t.toolName),
          });
        },
      });
      writer.merge(result.toUIMessageStream({ sendStart: false }));
    },
    onError: (e) => {
      log({ step: "error", error: String(e).slice(0, 300) });
      return "Не получилось ответить — попробуйте ещё раз или переформулируйте запрос.";
    },
  });
  return createUIMessageStreamResponse({
    stream,
    headers: { "x-so-mode": isMock() ? "mock" : provider(), "x-so-jev": jevEnabled() ? "on" : "rules" },
  });
}

function log(rec: Record<string, unknown>) {
  if (process.env.SO_QUIET === "1") return;
  console.log("[chat]", JSON.stringify({ t: new Date().toISOString(), ...rec }));
}
