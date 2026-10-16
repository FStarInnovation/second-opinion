/**
 * Тело и заголовки POST /api/chat (план WP-TG §4.4, §4.5, инвариант И5): тело побайтно как у браузера (assistant-ui поверх
 * AbstractChat ai@7.0.133); канал и ключ бота — только в заголовках, тело от этого не меняется (§3 решение 5).
 *   тело    = { tools: {}, inputs?, id, messages, trigger: "submit-message", metadata: {} } — inputs в КАЖДОМ запросе разговора,
 *             начатого ссылкой с q (даже пустым объектом), как ChatApp.tsx;
 *   user    = { role, parts: [{ type: "text", text }], metadata: { custom: {} }, id };
 *   assistant = { id, role, parts } — части как их собрал ai (история — сырые UIMessage, §3 решение 4).
 */
import type { UIMessage } from "ai";
import type { ReportInputs } from "@so/engine/contract";
import { HDR } from "@so/present/protocol";
import type { BotConfig } from "./config";

/** Разговор бота. chatId и pseudo живут только в памяти бота (§8); на сервер уходит только sessionId */
export interface Conv { pseudo: string; chatId: number; sessionId: string; messages: UIMessage[]; inputs?: ReportInputs; lastActive: number }

/** Сообщение пользователя в форме браузера */
export function userMessage(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }], metadata: { custom: {} } } as UIMessage;
}

/** Сообщение в проводе: user — {role, parts, metadata, id}; assistant (и прочие) — {id, role, parts} */
export function toWire(m: UIMessage): unknown {
  if (m.role === "user") return { role: m.role, parts: m.parts, metadata: m.metadata ?? { custom: {} }, id: m.id };
  return { id: m.id, role: m.role, parts: m.parts };
}

/** Запрос хода: URL сервера решений, тело как у браузера, заголовки браузера плюс x-so-channel и x-so-bot-key */
export function buildChatRequest(c: Conv, cfg: Pick<BotConfig, "webUrl" | "botKey">):
  { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } } {
  const body = {
    tools: {},
    ...(c.inputs !== undefined ? { inputs: c.inputs } : {}),
    id: c.sessionId,
    messages: c.messages.map(toWire),
    trigger: "submit-message",
    metadata: {},
  };
  return {
    url: `${cfg.webUrl.replace(/\/+$/, "")}/api/chat`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", [HDR.chat]: c.sessionId, [HDR.channel]: "telegram", [HDR.botKey]: cfg.botKey },
      body: JSON.stringify(body),
    },
  };
}
