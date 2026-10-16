/**
 * Один ход разговора (план WP-TG §3 решение 3, §4.4): POST /api/chat с телом браузера, ответ — SSE UI-потока, собранный
 * функциями ai@7.0.133 (parseJsonEventStream + uiMessageChunkSchema + readUIMessageStream — тот же processUIMessageStream, что
 * под assistant-ui в браузере). Своего разбора SSE нет.
 *
 * Повтор POST — ТОЛЬКО при отказе соединения (ECONNREFUSED в code или cause.code): Next перезапускается, ход ещё не начат.
 * До 3 повторов с паузами 2/8/20 с; не вышло — reason "refused" (ядро уберёт реплику из истории). HTTP-ошибка, обрыв потока,
 * чанк error, таймаут хода — без повтора: ход не идемпотентен (бюджет, session.result); частичный ответ — в partial.
 * onToolInput — по разу на инструмент, как только его вход готов (input-available или дальше): ядро успевает отправить текст
 * модели перед инструментом и заглушку до сборки отчёта.
 */
import { generateId, parseJsonEventStream, readUIMessageStream, uiMessageChunkSchema, type UIMessage, type UIMessageChunk } from "ai";
import type { BotConfig } from "./config";
import { toolNameOf } from "./render";
import { buildChatRequest, type Conv } from "./request";

export type TurnOutcome = { ok: true; assistant: UIMessage }
  | { ok: false; reason: "refused" | "http" | "stream" | "timeout"; status?: number; partial?: UIMessage };

/** Паузы перед повторами POST при ECONNREFUSED */
const RETRY_PAUSES_MS = [2000, 8000, 20000] as const;

/** Отказ соединения: code ECONNREFUSED на ошибке, в cause или среди errors (AggregateError при нескольких адресах) */
function isConnRefused(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== "object" || depth > 4) return false;
  const o = e as { code?: unknown; cause?: unknown; errors?: unknown };
  if (o.code === "ECONNREFUSED") return true;
  if (isConnRefused(o.cause, depth + 1)) return true;
  return Array.isArray(o.errors) && o.errors.some((x) => isConnRefused(x, depth + 1));
}

type AnyPart = { type: string; toolCallId?: unknown; toolName?: unknown; state?: unknown };
const INPUT_READY = new Set(["input-available", "approval-requested", "approval-responded", "output-available", "output-error", "output-denied"]);

class TimeoutSignal { readonly timeout = true; }

/** Ход: запрос, сборка ответа, исход. Никогда не бросает; таймер хода снимается в finally */
export async function runTurn(c: Conv, cfg: BotConfig, d: {
  fetch: typeof fetch; sleep(ms: number): Promise<void>;
  onToolInput?(toolCallId: string, toolName: string, partial: UIMessage): void;
}): Promise<TurnOutcome> {
  const { url, init } = buildChatRequest(c, cfg);
  const ac = new AbortController();
  let timedOut = false;
  let fire: (v: TimeoutSignal) => void = () => {};
  const timeoutP = new Promise<TimeoutSignal>((res) => { fire = res; });
  const timer = setTimeout(() => { timedOut = true; fire(new TimeoutSignal()); try { ac.abort(); } catch { /* уже */ } }, Math.max(1, cfg.turnTimeoutMs));
  /** Ожидание с учётом таймаута хода: таймаут — TimeoutSignal */
  const orTimeout = <T>(p: Promise<T>): Promise<T | TimeoutSignal> => Promise.race([p, timeoutP]);
  let last: UIMessage | undefined;
  try {
    /* 1. POST с повтором только при ECONNREFUSED */
    let res: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await orTimeout(d.fetch(url, { ...init, signal: ac.signal }));
        if (r instanceof TimeoutSignal) return { ok: false, reason: "timeout" };
        res = r;
        break;
      } catch (e) {
        if (timedOut) return { ok: false, reason: "timeout" };
        if (!isConnRefused(e)) return { ok: false, reason: "http" };
        if (attempt >= RETRY_PAUSES_MS.length) return { ok: false, reason: "refused" };
        const s = await orTimeout(d.sleep(RETRY_PAUSES_MS[attempt]));
        if (s instanceof TimeoutSignal) return { ok: false, reason: "timeout" };
      }
    }
    if (!res.ok || !res.body) {
      try { await res.body?.cancel(); } catch { /* тело не нужно */ }
      return { ok: false, reason: "http", status: res.status };
    }

    /* 2. Сборка ответа функциями ai; ошибка потока, невалидный чанк или чанк error — сбой хода */
    let failed = false;
    const chunks = parseJsonEventStream({ stream: res.body, schema: uiMessageChunkSchema }).pipeThrough(
      new TransformStream<{ success: boolean; value?: unknown; error?: unknown }, UIMessageChunk>({
        transform(part, ctl) {
          if (!part.success) { failed = true; return; }
          const v = part.value as UIMessageChunk;
          if (v.type === "error") failed = true;
          ctl.enqueue(v);
        },
      }),
    );
    const notified = new Set<string>();
    const read = (async () => {
      for await (const snap of readUIMessageStream<UIMessage>({ stream: chunks, onError: () => { failed = true; } })) {
        last = snap;
        if (!d.onToolInput) continue;
        for (const p of snap.parts as AnyPart[]) {
          const name = toolNameOf(p);
          const id = p.toolCallId;
          if (!name || typeof id !== "string" || notified.has(id) || !INPUT_READY.has(String(p.state))) continue;
          notified.add(id);
          try { d.onToolInput(id, name, snap); } catch { /* ошибка ядра не рвёт сборку ответа */ }
        }
      }
    })();
    const done = await orTimeout(read.then(() => null, () => { failed = true; return null; }));
    if (done instanceof TimeoutSignal || timedOut) {
      read.catch(() => {}); // дочитается после abort; ошибки уже не нужны
      return { ok: false, reason: "timeout", ...(last ? { partial: withId(last) } : {}) };
    }
    if (failed || !last) return { ok: false, reason: "stream", ...(last ? { partial: withId(last) } : {}) };
    return { ok: true, assistant: withId(last) };
  } catch {
    return { ok: false, reason: timedOut ? "timeout" : "stream", ...(last ? { partial: withId(last) } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

/** Ответ без start.messageId — id, как его даёт AbstractChat браузера (generateId) */
function withId(m: UIMessage): UIMessage {
  return m.id ? m : { ...m, id: generateId() };
}
