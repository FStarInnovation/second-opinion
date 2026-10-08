"use client";
/**
 * Tool UI чата: результат каждого инструмента рисуется ТЕМИ ЖЕ блоками, что и страница (инвариант 4).
 * Регистрируются через MessagePrimitive.Parts components.tools.by_name (современная замена makeAssistantToolUI).
 */
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { ReportView, PickView, NotFoundView, ErrView } from "@so/blocks";
import type { ReportToolResult, ExplainResult } from "@/lib/tools";

function Pending({ label }: { label: string }) {
  return <div className="so-tool so-tool--pending" role="status"><span className="so-dot" />{label}</div>;
}

export function ReportToolUI(p: ToolCallMessagePartProps<Record<string, unknown>, ReportToolResult | { error: string }>) {
  if (p.status.type === "running" || p.result === undefined) return <Pending label="Собираю отчёт по данным Мосбиржи…" />;
  if ("error" in p.result) return <p className="note note--bad">{p.result.error}</p>;
  const res = p.result.result;
  return (
    <div className="so so-tool so-tool--report" data-tool={p.toolName}>
      {res.kind === "report" ? (
        <ReportView report={res.report} compact showInputs={false} askPriceUnavailableNote="Напишите цену предложения в чате — пересчитаю." />
      ) : res.kind === "pick" ? (
        <PickView res={res} hrefFor={(secid) => `/check?q=${encodeURIComponent(secid)}`} />
      ) : res.kind === "notfound" ? (
        <NotFoundView res={res} newCheckHref="/" />
      ) : (
        <ErrView res={res} newCheckHref="/" />
      )}
    </div>
  );
}

export function ExplainToolUI(p: ToolCallMessagePartProps<{ term: string }, ExplainResult>) {
  if (p.status.type === "running" || p.result === undefined) return <Pending label="Ищу в глоссарии…" />;
  if (!p.result.found)
    return <p className="note">В глоссарии нет такого термина. Есть: {p.result.known.slice(0, 6).join(", ")}…</p>;
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
