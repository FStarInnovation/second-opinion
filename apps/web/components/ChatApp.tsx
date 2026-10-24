"use client";
import { useEffect, useMemo, useRef } from "react";
import { AssistantRuntimeProvider, useAui, useAuiState } from "@assistant-ui/react";
import { useChatRuntime, AssistantChatTransport } from "@assistant-ui/react-ai-sdk";
import type { ReportInputs } from "@so/engine/contract";
import { SiteHeader } from "@so/blocks";
import { Thread } from "./Thread";

/** Вход в чат, уже проверенный сервером (app/chat/page.tsx): переход с /check — бумага и вводы; вопрос с главной — text (?m=…). */
export type ChatInitial = { q: string; inputs: ReportInputs; text?: never } | { text: string; q?: never; inputs?: never };

/** Первое сообщение. С главной — текст пользователя как есть. С /check — только то, что гейт надёжно разбирает в одной реплике
 *  (check_security + «обещали»); сумма / комиссия / цена идут полем inputs тела запроса, не текстом (одна реплика — одно намерение, R2-21). */
const firstText = (i: ChatInitial) =>
  i.text ?? `Проверь ${i.q}` + (i.inputs?.promised_pct != null ? `, обещали ${String(i.inputs.promised_pct).replace(".", ",")}%` : "");

/** Автоотправка первого сообщения при переходе с /check или с главной: один раз и только в пустую ленту. Отправка — в таймере после
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

/** Вопрос с главной уже передан в чат (initial.text) — убираем m из адресной строки: текст пользователя не остаётся
 *  в истории браузера, в закладках и в адресе, который видят счётчики. Остальные параметры не трогаем. */
function useDropM(): void {
  useEffect(() => {
    const u = new URL(window.location.href);
    if (!u.searchParams.has("m")) return;
    u.searchParams.delete("m");
    window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
  }, []);
}

export function ChatApp({ mock, initial }: { mock?: boolean; initial?: ChatInitial }) {
  useDropM();
  // id сессии — для серверного состояния (последний отчёт) и лимита сообщений
  const chatId = useMemo(() => "c_" + Math.random().toString(36).slice(2, 12), []);
  // Вводы /check — полем inputs тела каждого запроса: сервер принимает их, пока в сессии нет отчёта, и применяет один раз.
  // Вопрос с главной (?m=…) вводов не несёт — тело без inputs.
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({
      api: "/api/chat", headers: { "x-so-chat": chatId },
      ...(initial?.inputs ? { body: { inputs: initial.inputs } } : {}),
    }),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {initial ? <AutoSend text={firstText(initial)} /> : null}
      <div className="so so-chat-page">
        <SiteHeader homeHref="/" />
        <Thread mock={mock} />
      </div>
    </AssistantRuntimeProvider>
  );
}
