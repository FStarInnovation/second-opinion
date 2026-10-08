"use client";
import { useEffect, useMemo, useState } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { SiteHeader } from "@so/blocks";
import { Thread } from "./Thread";

type Health = { mode: string; model: string; jev: { provider: string; ok: boolean; ms: number; error?: string } | null };

export function ChatApp({ status, mock }: { status?: string; mock?: boolean }) {
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
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: "/api/chat", headers: { "x-so-chat": chatId } }),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="so so-chat-page">
        <SiteHeader homeHref="/" />
        <Thread status={statusLine} mock={mock} />
      </div>
    </AssistantRuntimeProvider>
  );
}
