"use client";
import { useRouter } from "next/navigation";
import type { BuildResultT, ReportInputs } from "@so/engine/contract";
import { ResultApp } from "@so/blocks";

/** Переход «отчёт → ассистент»: та же бумага (ISIN стабильнее текста запроса) и те же вводы — актуальные, из состояния ResultApp.
 *  Контракт параметров — docs/PLAN_check-to-chat_2026-10-10.md §3; /chat их валидирует сам (схема set_inputs). */
function chatHref(res: BuildResultT, query: string): string | null {
  if (res.kind !== "report") return null;
  const r = res.report;
  const q = (r.security.isin ?? r.security.secid ?? query).trim();
  if (!q || q.length > 200) return null;
  const sp = new URLSearchParams({ q });
  const i = r.inputs;
  if (i.promised_pct != null && i.promised_pct > 0) sp.set("promised", String(i.promised_pct));
  if (i.position_size != null) sp.set("pos", String(i.position_size));
  if (i.k_pct != null) sp.set("k", String(i.k_pct));
  if (i.offer_price_pct != null) sp.set("price", String(i.offer_price_pct)); // отчёт собран по цене пользователя (ветка «нет цены»)
  return `/chat?${sp}`;
}

function ChatLink({ href }: { href: string }) {
  return (
    <div data-block="chat_link" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      <a className="btn btn-outline" href={href}>Обсудить с ассистентом</a>
      <p className="cap">Те же блоки — в диалоге: спросить про риски и термины, пересчитать под другую сумму</p>
    </div>
  );
}

export function CheckClient({ query, result, chatEnabled }: { query: string; result: BuildResultT; chatEnabled?: boolean }) {
  const router = useRouter();
  const rebuild = async (inputs: ReportInputs): Promise<BuildResultT> => {
    const res = await fetch("/api/report", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, inputs: { ...(result.kind === "report" ? result.report.inputs : {}), ...inputs } }),
    });
    return (await res.json()) as BuildResultT;
  };
  // Без чата (SO_CHAT=0) кнопки нет: прямой путь остаётся без LLM, модель — только после перехода и на вопросы пользователя
  const renderAfter = chatEnabled
    ? (res: BuildResultT) => { const href = chatHref(res, query); return href ? <ChatLink href={href} /> : null; }
    : undefined;
  return (
    <ResultApp
      result={result}
      homeHref="/"
      hrefFor={(secid) => `/check?q=${encodeURIComponent(secid)}`}
      rebuild={rebuild}
      renderAfter={renderAfter}
      key={query + (result.kind === "report" ? result.report.inputs.offer_price_pct ?? "" : "")}
    />
  );
}
