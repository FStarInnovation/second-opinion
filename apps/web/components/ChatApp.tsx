"use client";
import { useMemo } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import { SiteHeader } from "@so/blocks";
import { Thread } from "./Thread";

export function ChatApp({ status, mock }: { status?: string; mock?: boolean }) {
  // id сессии — для серверного состояния (последний отчёт) и лимита сообщений
  const chatId = useMemo(() => "c_" + Math.random().toString(36).slice(2, 12), []);
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: "/api/chat", headers: { "x-so-chat": chatId } }),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="so so-chat-page">
        <SiteHeader homeHref="/" />
        <Thread status={status} mock={mock} />
      </div>
    </AssistantRuntimeProvider>
  );
}
