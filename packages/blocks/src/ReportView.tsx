/**
 * Композиция страницы отчёта: рендерит ТОЛЬКО блоки из r.panels (их выбрал движок — composePanels),
 * раскладывая их по сетке прототипа v3. Шаблон не содержит фактов о бумаге.
 * Один и тот же компонент — на статической странице (Э2) и в tool renderer чата (Э3), инвариант 4.
 */
import type { BondReportT, PanelIdT, ReportInputs } from "@so/engine/contract";
import {
  AskPrice, Claim, DataLine, Fees, FlagsScore, InputsPanel, Liquidity, Macro, Plaque, PriceLine, Product, Worst, Yield,
} from "./blocks.js";
import { BackIcon } from "./ui.js";

export interface ReportViewProps {
  report: BondReportT;
  /** Смена позиции / комиссии / «обещали» — хост пересчитывает через applyInputs движка. */
  onInputs?: (i: ReportInputs) => void;
  /** Ветка «нет цены»: цена предложения → полная пересборка build() на сервере. */
  onAskPrice?: (pricePct: number) => void;
  askPriceUnavailableNote?: string;
  newCheckHref?: string;
  cabinetHref?: string;
  /** В чате (Э3) шапка страницы и кнопка «Новая проверка» не нужны. */
  compact?: boolean;
}

export const CABINET_HREF = "https://vfo.autremus.com";

export function ReportView(p: ReportViewProps) {
  const r = p.report;
  const has = (id: PanelIdT) => r.panels.includes(id);
  const yieldCard = has("claim") || has("yield") || has("price_line") || has("ask_price");
  const showInputs = has("liquidity") || has("fees");
  const row3 = has("liquidity") || has("fees") || has("worst");

  return (
    <div className={p.compact ? "stack" : "so-main"} data-report={r.schema} data-status={r.status.kind}>
      {!p.compact ? (
        <a className="btn btn-ghost" href={p.newCheckHref ?? "./"}><BackIcon />Новая проверка</a>
      ) : null}

      <div className="so-title">
        {has("data_line") ? <DataLine r={r} /> : null}
        <span className="so-title__kind">Базовый отчёт · облигация</span>
        <h1>{r.security.shortname}</h1>
        {r.security.isin ? <p className="cap mono">{r.security.isin}</p> : null}
      </div>

      {has("product") ? <Product r={r} /> : null}

      {yieldCard || has("flags_score") ? (
        <div className="grid-2">
          {yieldCard ? (
            <section className="card" aria-labelledby="h-yield" style={{ gap: 16 }}>
              <h2 id="h-yield">Доходность</h2>
              {has("claim") ? <Claim r={r} /> : null}
              {has("ask_price") ? <AskPrice r={r} onSubmit={p.onAskPrice} unavailableNote={p.askPriceUnavailableNote} /> : null}
              {has("yield") ? <Yield r={r} /> : null}
              {has("price_line") ? <PriceLine r={r} /> : null}
            </section>
          ) : null}
          {has("flags_score") ? <FlagsScore r={r} /> : null}
        </div>
      ) : null}

      {showInputs ? <InputsPanel r={r} onInputs={p.onInputs} /> : null}

      {row3 ? (
        <div className="grid-3">
          {has("liquidity") ? <Liquidity r={r} /> : null}
          {has("fees") ? <Fees r={r} /> : null}
          {has("worst") ? <Worst r={r} /> : null}
        </div>
      ) : null}

      {has("macro") ? <Macro r={r} /> : null}
      {has("plaque") ? <Plaque cabinetHref={p.cabinetHref ?? CABINET_HREF} /> : null}

      <p className="cap">Не является индивидуальной инвестиционной рекомендацией.</p>
    </div>
  );
}
