/**
 * @so/blocks — реестр React-блоков отчёта. Чистые компоненты от контракта bond_report@1,
 * без зависимости от assistant-ui: в Э3 чат подключит их через makeAssistantToolUI.
 */
import type { ComponentType } from "react";
import type { BondReportT, PanelIdT } from "@so/engine/contract";
import {
  AskPrice, Claim, DataLine, Fees, FlagsScore, Liquidity, Macro, Plaque, PriceLine, Product, Worst, Yield,
} from "./blocks.js";

export * from "./blocks.js";
export * from "./ReportView.js";
export * from "./branches.js";
export * from "./app.js";
export { Bars, scoreTone, liquidityTone } from "./ui.js";

/** Реестр: id панели → компонент. Plaque не зависит от контракта (статичный текст П23). */
export const BLOCKS: Record<PanelIdT, ComponentType<{ r: BondReportT }>> = {
  data_line: DataLine,
  product: Product,
  claim: Claim,
  yield: Yield,
  price_line: PriceLine,
  ask_price: AskPrice,
  liquidity: Liquidity,
  fees: Fees,
  worst: Worst,
  flags_score: FlagsScore,
  macro: Macro,
  plaque: () => Plaque({ cabinetHref: "https://vfo.autremus.com" }),
};
