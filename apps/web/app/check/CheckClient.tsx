"use client";
import { useRouter } from "next/navigation";
import type { BuildResultT, ReportInputs } from "@so/engine/contract";
import { ResultApp } from "@so/blocks";

export function CheckClient({ query, result }: { query: string; result: BuildResultT }) {
  const router = useRouter();
  const rebuild = async (inputs: ReportInputs): Promise<BuildResultT> => {
    const res = await fetch("/api/report", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, inputs: { ...(result.kind === "report" ? result.report.inputs : {}), ...inputs } }),
    });
    return (await res.json()) as BuildResultT;
  };
  return (
    <ResultApp
      result={result}
      homeHref="/"
      hrefFor={(secid) => `/check?q=${encodeURIComponent(secid)}`}
      rebuild={rebuild}
      key={query + (result.kind === "report" ? result.report.inputs.offer_price_pct ?? "" : "")}
    />
  );
}
