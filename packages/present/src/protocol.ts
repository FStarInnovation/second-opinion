/**
 * Протокол между сервером решений (apps/web) и его клиентами — браузером и Telegram-ботом (план WP-TG §4.1).
 * Чистый TS: без React, Node и `ai`. Имена инструментов и формы их выходов — те же, что пишет сервер (apps/web/lib/tools.ts).
 */
import type { BuildResultT } from "@so/engine/contract";

/** Одобренный реестр инструментов ассистента (apps/web/lib/tools.ts) */
export const TOOL_NAMES = ["resolve_security", "build_bond_report", "set_inputs", "explain_term"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Результат любого инструмента отчёта — конверт движка плюс запрос, по которому он собран. */
export type ReportToolResult = { query: string; result: BuildResultT };
export type ExplainResult = { found: true; id: string; title: string; text: string } | { found: false; query: string; known: string[] };

/** Сколько живёт сессия чата на сервере без обращений (apps/web/lib/session.ts) */
export const SESSION_TTL_MS = 60 * 60_000;
/** Запас бота: его история разговора живёт SESSION_TTL_MS − BOT_TTL_MARGIN_MS, то есть заканчивается раньше серверной сессии */
export const BOT_TTL_MARGIN_MS = 5 * 60_000;

/** Канал клиента: сайт или Telegram-бот */
export type Channel = "web" | "telegram";
/** Заголовки запроса POST /api/chat: id сессии, канал, ключ бота */
export const HDR = { chat: "x-so-chat", channel: "x-so-channel", botKey: "x-so-bot-key" } as const;
/** Префикс id сессий бота */
export const TG_SESSION_PREFIX = "tg_";
/** Кабинет: полный отчёт — после входа */
export const CABINET_HREF = "https://vfo.autremus.com";
