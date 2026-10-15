"use client";
/**
 * Tool UI чата: результат каждого инструмента рисуется ТЕМИ ЖЕ блоками, что и страница (инвариант 4).
 * Регистрируются через MessagePrimitive.Parts components.tools.by_name (современная замена makeAssistantToolUI).
 */
import { useAui, useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import type { BuildResultT } from "@so/engine/contract";
import { ReportView, PickView, NotFoundView, ErrView } from "@so/blocks";
import type { ReportToolResult, ExplainResult } from "@so/present/protocol";
import { pickMessage } from "@so/present/entry";
import { WAIT_REPORT, WAIT_TERM } from "@so/present/copy";

function Pending({ label }: { label: string }) {
  return <div className="so-tool so-tool--pending" role="status"><span className="so-dot" />{label}</div>;
}

/** Выбор выпуска в чате: реплика «Проверь <ISIN>» уходит в тот же диалог (как автоотправка в ChatApp), без перехода на /check —
 *  сумма и комиссия сессии не теряются. Пока ассистент отвечает, кнопки неактивны: второй клик не шлёт вторую реплику. */
function ChatPick({ res }: { res: Extract<BuildResultT, { kind: "pick" }> }) {
  const aui = useAui();
  const busy = useAuiState((s) => s.thread.isRunning || s.thread.isDisabled);
  const pick = (secid: string) => {
    if (aui.thread.getState().isRunning) return;
    const c = res.candidates.find((x) => x.secid === secid);
    aui.thread.append({ role: "user", content: [{ type: "text", text: pickMessage(c ?? { secid }) }] });
  };
  return <PickView res={res} onPick={busy ? undefined : pick} compact />;
}

export function ReportToolUI(p: ToolCallMessagePartProps<Record<string, unknown>, ReportToolResult | { error: string }>) {
  if (p.status.type === "running" || p.result === undefined) return <Pending label={WAIT_REPORT} />;
  if ("error" in p.result) return <p className="note note--bad">{p.result.error}</p>;
  const res = p.result.result;
  return (
    <div className="so so-tool so-tool--report" data-tool={p.toolName}>
      {res.kind === "report" ? (
        <ReportView report={res.report} compact showInputs={false} askPriceUnavailableNote="Напишите цену предложения в чате — пересчитаю." />
      ) : res.kind === "pick" ? (
        <ChatPick res={res} />
      ) : res.kind === "notfound" ? (
        <NotFoundView res={res} compact />
      ) : (
        <ErrView res={res} compact />
      )}
    </div>
  );
}

export function ExplainToolUI(p: ToolCallMessagePartProps<{ term: string }, ExplainResult>) {
  if (p.status.type === "running" || p.result === undefined) return <Pending label={WAIT_TERM} />;
  // Статьи нет — карточку не рисуем: отвечает модель своими словами, тупик «нет такого термина» рядом с ответом не нужен
  if (!p.result.found) return null;
  return (
    <section className="card so-tool so-tool--term" data-tool="explain_term" data-term={p.result.id}>
      <h2>{p.result.title}</h2>
      <p className="text">{p.result.text}</p>
    </section>
  );
}

export function ToolFallback(p: ToolCallMessagePartProps) {
  return (
    <p className="cap so-tool" data-tool={p.toolName}>
      {p.status.type === "running" ? `Выполняю ${p.toolName}…` : `Инструмент ${p.toolName} выполнен.`}
    </p>
  );
}

export const TOOL_UIS = {
  resolve_security: ReportToolUI,
  build_bond_report: ReportToolUI,
  set_inputs: ReportToolUI,
  explain_term: ExplainToolUI,
} as const;
