/**
 * @so/blocks — реестр React-блоков отчёта. Чистые компоненты от контракта bond_report@1,
 * без зависимости от assistant-ui: в Э3 чат подключит их через makeAssistantToolUI.
 */
import type { ComponentType } from "react";
import type { BondReportT, PanelIdT } from "@so/engine/contract";
import { CABINET_HREF } from "@so/present/protocol";
import {
  AskPrice, Claim, DataLine, Fees, FlagsScore, Liquidity, Macro, Plaque, PriceLine, Product, Worst, Yield,
} from "./blocks";

export * from "./blocks";
export * from "./ReportView";
export * from "./branches";
export * from "./app";
export { Bars, BrandMark } from "./ui";
export { scoreTone, liquidityTone } from "@so/present/report";

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
  plaque: () => Plaque({ cabinetHref: CABINET_HREF }),
};
