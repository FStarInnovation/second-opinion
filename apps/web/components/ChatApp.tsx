"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import type { ReportInputs } from "@so/engine/contract";
import { SiteHeader } from "@so/blocks";
import { Thread } from "./Thread";

type Health = { mode: string; model: string; jev: { provider: string; ok: boolean; ms: number; error?: string } | null };

/** Переход с /check: бумага и вводы, уже проверенные сервером (app/chat/page.tsx). */
export type ChatInitial = { q: string; inputs: ReportInputs };

/** Первое сообщение — только то, что гейт надёжно разбирает в одной реплике (check_security + «обещали»);
 *  сумма / комиссия / цена идут полем inputs тела запроса, не текстом (одна реплика — одно намерение, R2-21). */
const firstText = (i: ChatInitial) =>
  `Проверь ${i.q}` + (i.inputs.promised_pct != null ? `, обещали ${String(i.inputs.promised_pct).replace(".", ",")}%` : "");

/** Автоотправка первого сообщения при переходе с /check: один раз и только в пустую ленту. Отправка — в таймере после
 *  коммита (рантайм уже подключил транспорт), таймер снимается при размонтировании — двойной эффект StrictMode не шлёт дважды. */
function AutoSend({ text }: { text: string }) {
  const aui = useAui();
  const ready = useAuiState((s) => !s.thread.isLoading && !s.thread.isDisabled);
  const sent = useRef(false);
  useEffect(() => {
    if (!ready || sent.current) return;
    const t = setTimeout(() => {
      if (sent.current) return;
      sent.current = true;
      if (!aui.thread.getState().isEmpty) return;
      aui.thread.append({ role: "user", content: [{ type: "text", text }] });
    }, 0);
    return () => clearTimeout(t);
  }, [ready, aui, text]);
  return null;
}

export function ChatApp({ status, mock, initial }: { status?: string; mock?: boolean; initial?: ChatInitial }) {
  // id сессии — для серверного состояния (последний отчёт) и лимита сообщений
  const chatId = useMemo(() => "c_" + Math.random().toString(36).slice(2, 12), []);
  // Живая проверка Jev: настроен ≠ отвечает. Один запрос при открытии чата, результат — в строку статуса.
  const [live, setLive] = useState<string | null>(null);
  useEffect(() => {
    if (mock) return;
    fetch("/api/health").then((r) => r.json()).then((h: Health) => {
      if (!h.jev) return;
      setLive(h.jev.ok ? `Jev отвечает (${h.jev.ms} мс)` : `Jev не отвечает → правила: ${h.jev.error ?? "пустой ответ"}`);
    }).catch(() => setLive(null));
  }, [mock]);
  const statusLine = status && live ? `${status} · ${live}` : status;
  // Вводы /check — полем inputs тела каждого запроса: сервер принимает их, пока в сессии нет отчёта, и применяет один раз
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({
      api: "/api/chat", headers: { "x-so-chat": chatId },
      ...(initial ? { body: { inputs: initial.inputs } } : {}),
    }),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {initial ? <AutoSend text={firstText(initial)} /> : null}
      <div className="so so-chat-page">
        <SiteHeader homeHref="/" />
        <Thread status={statusLine} mock={mock} />
      </div>
    </AssistantRuntimeProvider>
  );
}
