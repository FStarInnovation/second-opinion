/**
 * Контракт bond_report@1 — единственный интерфейс между движком и любым рендером.
 * Инвариант 3 плана: не хватает поля — расширяем контракт, а не считаем в UI.
 * Методика: Claude Doc «Second opinion · Облигации: постановка с исправлениями и методика метрик».
 */
import { z } from "zod";

export const SCHEMA_ID = "bond_report@1" as const;

export const StatusKind = z.enum(["ok", "no_price", "not_traded", "no_coupon_rate", "structured", "perpetual"]);

export const PanelId = z.enum([
  "data_line", "product", "claim", "yield", "price_line", "ask_price",
  "liquidity", "fees", "worst", "flags_score", "macro", "plaque",
]);

const num = z.number().finite();
const pct = num; // проценты годовых, 19.21 = 19,21%

export const YieldValue = z.object({ label: z.string(), pct });

export const BondReport = z.object({
  schema: z.literal(SCHEMA_ID),
  product_type: z.literal("bond"),
  built_at: z.string(), // ISO
  data_time: z.object({
    updatetime: z.string().nullable(), // HH:MM:SS МСК
    trade_date: z.string().nullable(), // YYYY-MM-DD
    line: z.string(), // «Данные Мосбиржи на HH:MM МСК, ДД.ММ.ГГГГ. Задержка до 15 минут» (П30)
  }),
  security: z.object({
    secid: z.string(),
    isin: z.string().nullable(),
    boardid: z.string().nullable(),
    shortname: z.string(),
    name: z.string().nullable(),
    regnumber: z.string().nullable(),
    emitent_title: z.string().nullable(),
    typename: z.string().nullable(),
  }),
  status: z.object({
    kind: StatusKind,
    reason: z.string().nullable(),
  }),
  product: z.object({
    plain_text: z.string(),
    coupon_kind: z.enum(["fixed", "float", "zero", "linker"]),
    coupon_label: z.string(),
    amortization: z.boolean(),
    offer: z.object({
      type: z.enum(["put", "call", "none"]),
      date: z.string().nullable(),
      price_pct: num.nullable(),
      price_assumed_par: z.boolean(), // «цена выкупа не раскрыта, принята равной номиналу»
      days_to: num.nullable(),
    }),
    faceunit: z.string(),
    currency_word: z.string(), // «рублях» / «юанях» / …
    listlevel: num.nullable(),
    qualified: z.boolean(),
    maturity_date: z.string().nullable(),
  }),
  claim: z.object({
    promised_pct: pct.nullable(), // null — блок скрыт
    promised_text: z.string().nullable(),
    source: z.enum(["field", "file"]).nullable(),
    gap_pp: num.nullable(), // обещали − расчётная
    line: z.string().nullable(), // «Обещали: … · На самом деле: … · Разница: …»
  }),
  yield: z.object({
    kind: z.enum(["single", "scenarios", "period_income", "not_calculated"]),
    horizon: z.enum(["maturity", "offer", "call"]).nullable(),
    horizon_date: z.string().nullable(),
    horizon_label: z.string().nullable(), // «погашения 15.05.2041»
    values: z.array(YieldValue), // single: 1; scenarios: 3
    main_pct: pct.nullable(), // число для сравнений (сценарий 1 у флоатера)
    period_income: z
      .object({ days: num, gain_money: num, gain_pct: num, date: z.string() })
      .nullable(), // колл ≤ 30 дней
    exchange: z.object({
      pct: pct.nullable(), // EFFECTIVEYIELDWAPRICE (к дате YIELDDATETYPE)
      price_pct: num.nullable(),
      datetype: z.string().nullable(), // MATDATE | OFFER
      used_as_main: z.boolean(),
    }),
    own_control_pct: pct.nullable(),
    control_diff_pp: num.nullable(),
    // гейт controlFailPp (WP-D): control_diff_pp > CONFIG.controlFailPp — свой расчёт по графику выплат не сошёлся с биржевым;
    // главной остаётся биржевая (exchange.used_as_main; иначе own с пометкой в line), производное от own (k_grid, pre/post_tax,
    // панель fees, worst.call с own-числом) не публикуется, в line — фраза «не сошёлся»
    control_failed: z.boolean(),
    not_calculated_reason: z.string().nullable(),
    line: z.string().nullable(), // готовая фраза вывода доходности
  }),
  price: z.object({
    clean_pct: num.nullable(),
    prev_used: z.boolean(), // PREVWAPRICE, «по вчерашней средневзвешенной»
    from_user: z.boolean(), // ветка «нет цены», цена предложения
    facevalue: num.nullable(),
    accruedint: num.nullable(),
    full_price: num.nullable(),
    clean_price: num.nullable(),
    next_coupon_date: z.string().nullable(),
    currency: z.string(),
    line: z.string().nullable(), // «Цена покупки … = … + НКД …; НКД вернётся …»
  }),
  liquidity: z.object({
    traded: z.boolean(),
    avg_turnover: num.nullable(),
    days_counted: num,
    trades_per_day: num.nullable(),
    spread_pct: num.nullable(),
    spread_missing_side: z.boolean(),
    position_size: num,
    share_pct: num.nullable(),
    exit_now_pct: num.nullable(),
    exit_now_money: num.nullable(),
    exit_days: num.nullable(),
    category: z.enum(["норм", "умеренно", "низкая", "—"]),
    no_exit: z.boolean(),
    line: z.string(), // зависит от позиции
    metrics_line: z.string().nullable(), // «За 20 торговых дней: средний оборот … ; спред …»
  }),
  fees_tax: z.object({
    k_pct: num.nullable(), // null — приглашение ввести
    k_grid: z.array(z.tuple([num, pct.nullable(), pct.nullable()])), // [k, до налога, после]
    pre_tax_pct: pct.nullable(),
    post_tax_pct: pct.nullable(),
    tax_note: z.string(),
    line: z.string().nullable(), // null — сетка пуста (статус не ok или гейт controlFailPp), панели fees нет
  }),
  worst: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      text: z.string(),
      loss_pct_1pp: num.nullable(), // падение цены при росте ставок на 1 п.п., % (только id = rates)
      loss_pct_3pp: num.nullable(),
    }),
  ),
  flags: z.array(
    z.object({
      id: num.int().min(1).max(15), // 1–13 по постановке, 14 структурная, 15 бессрочная (09.10.2026)
      title: z.string(),
      text: z.string(),
      fired: z.boolean(),
      points: num,
      details: z.string(),
    }),
  ),
  truth_score: z.object({
    score: num,
    grade: z.string(),
    top3: z.array(num.int()),
    more_count: num,
    none_fired: z.boolean(),
  }),
  macro: z.null(), // дополнение к П29 — на согласовании; появится отдельной схемой
  panels: z.array(PanelId),
  inputs: z.object({
    position_size: num,
    k_pct: num.nullable(),
    promised_pct: pct.nullable(),
    offer_price_pct: num.nullable(),
  }),
  diagnostics: z.object({
    snapshot_dir: z.string().nullable(),
    control_diff_pp: num.nullable(),
    warnings: z.array(z.string()),
  }),
});

export type BondReportT = z.infer<typeof BondReport>;
export type PanelIdT = z.infer<typeof PanelId>;

/* ───── Конверт результата build(): отчёт или ветки распознавания (2.3.0) ───── */
export const Candidate = z.object({
  secid: z.string(),
  isin: z.string().nullable(),
  shortname: z.string(),
  regnumber: z.string().nullable(),
  is_traded: z.boolean(),
  emitent_title: z.string().nullable(),
});

export const BuildResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("report"), report: BondReport }),
  z.object({ kind: z.literal("pick"), query: z.string(), note: z.string(), candidates: z.array(Candidate) }),
  z.object({ kind: z.literal("notfound"), query: z.string(), isinValid: z.boolean() }),
  z.object({ kind: z.literal("err"), query: z.string(), msg: z.string() }),
]);

export type CandidateT = z.infer<typeof Candidate>;
export type BuildResultT = z.infer<typeof BuildResult>;

/**
 * Ввод пользователя — единственная схема (И4 плана WP-TG): инструмент set_inputs и build_bond_report, поле inputs тела /api/chat,
 * параметры /chat?q=… и deep-link бота (@so/present/entry), страница /check и /api/report. Описания полей видит модель
 * (inputSchema инструментов), поэтому они — часть контракта.
 */
export const ReportInputsSchema = z.object({
  position_size: z.number().int().min(1000).max(1e10).optional().describe("Сумма вложения в рублях"),
  k_pct: z.number().min(0).max(3).nullable().optional().describe("Комиссия брокера, % от суммы сделки; null — убрать"),
  promised_pct: z.number().min(0).max(100).nullable().optional().describe("Сколько пообещал продавец, % годовых; null — убрать"),
  offer_price_pct: z.number().min(1).max(300).nullable().optional().describe("Цена предложения, % от номинала — только когда у бумаги нет биржевой цены"),
});

/** Ввод пользователя, меняющий отчёт без похода в ISS (кроме offer_price_pct — та требует пересборки). */
export interface ReportInputs {
  position_size?: number;
  k_pct?: number | null;
  promised_pct?: number | null;
  promised_text?: string | null;
  promised_source?: "field" | "file" | null;
  offer_price_pct?: number | null;
}
