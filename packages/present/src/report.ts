/**
 * View-model отчёта и веток распознавания (план WP-TG §4.1, инвариант И3 «один текст отчёта»): всё, что пользователь видит
 * в блоках отчёта, — готовые строки отсюда. Сайт (@so/blocks) и Telegram-бот только раскладывают их; своих текстов и
 * форматирования чисел у них нет (TG.6, TG.7). Числа считает движок: здесь они только печатаются (fmt/fmtMax/plural из
 * @so/engine/format), а тон берётся по порогам CONFIG движка. Чистый TS: без React, Node и `ai`.
 *
 * Секции — по раскладке ReportView (packages/blocks/src/ReportView.tsx), только панели из r.panels:
 *   product, [claim, ask_price, yield, price_line] — карточка «Доходность», flags_score, liquidity, fees, worst.
 * У карточки «Доходность» один заголовок: его несёт первая её секция, у остальных title пустой (секция продолжает карточку).
 *
 * Форма строк секций (порядок значим — сайт раскладывает их по своим местам; необязательное — только в конце):
 *   product      lines [описание, причина статуса?]
 *   claim        lines [«Обещали: … · На самом деле: … · Разница: …»], tone good/bad — красный при разнице больше порога флага 12
 *   ask_price    lines [поясняющий абзац]; note — askPriceNote (видна только после отправки формы, в vmStrings не входит)
 *   yield        big — «+X% за период до колла …» (period_income: до первого пробела число, дальше подпись) или причина
 *                «не рассчитана» (tone none); barsCaption и bars — бары доходности; lines [вывод доходности]
 *   price_line   lines [из чего сложилась цена]
 *   flags_score  subtitle; big «N / 100» (до первого пробела балл); lines [градация, «Ни один из N red flags не сработал.» |
 *                «Главные red flags», «Ещё N — в полном отчёте»?]; items — главные флаги, badge «−N»
 *   liquidity    big — метка ликвидности; lines [строка выхода, метрики?]
 *   fees         big «X% после …» (до первого пробела число) — только когда есть доходность после налога; lines [строка
 *                комиссии, «Налог …»]
 *   worst        items — риски
 * Плашка: title и items; последний пункт items — условие без входа («Без входа базовый отчёт доступен только в этой сессии.»).
 * Ветки: pick — lines [«По запросу … нашли N выпусков…», сноска о порядке]; notfound — lines [«Искали: <запрос>»,
 * причина?, сноска о документе]; err — lines [текст ошибки].
 */
import type { BondReportT, BuildResultT, PanelIdT } from "@so/engine/contract";
import { CONFIG } from "@so/engine/config";
import { fmt, fmtMax, plural } from "@so/engine/format";
import { pickMessage } from "./entry";

/* ═══════════════════════════ тексты ═══════════════════════════ */

const T = {
  kicker: "Базовый отчёт · облигация",
  product: "Что это за продукт простыми словами",
  yieldCard: "Доходность",
  askPrice: "По бумаге не было сделок, поэтому биржевой цены нет. Укажите цену из предложения продавца — посчитаем доходность от неё.",
  barsYield: "Доходность",
  barsScenarios: "Доходность флоатера по сценариям ставок",
  barPromised: "Обещали",
  barActual: "На самом деле",
  barCalculated: "расчётная ",
  barPostTaxK: "После комиссии и налога",
  barPostTax: "После налога",
  periodIncome: (gain: string, date: string, money: string, cur: string) => `+${gain}% за период до колла ${date} — ${money} ${cur} на облигацию`,
  score: "Product Truth Score",
  scoreSub: (n: number) => `100 минус баллы за сработавшие red flags (${n} правил)`,
  scoreBig: (score: number) => `${score} / 100`,
  noneFired: (n: number) => `Ни один из ${n} red flags не сработал.`,
  topFlags: "Главные red flags",
  moreFlags: (n: number) => `Ещё ${n} — в полном отчёте`,
  flagPoints: (p: number) => `−${p}`,
  liquidity: "Ликвидность",
  noExit: "Выйти через биржу сейчас нельзя",
  fees: "Комиссии и налог",
  postTaxK: "после комиссии и налога",
  postTax: "после налога",
  tax: (note: string) => `Налог ${note}. Скрытых комиссий в структуре обычной облигации нет.`,
  worst: "Worst-case",
  plaque: "Полный отчёт — после входа",
  plaqueItems: [
    "Короткое объяснение и что важно знать перед покупкой",
    "Скоринг продукта и оценка под ваши цели",
    "Вопросы, которые стоит задать продавцу",
    "Отчёт сохранится в «Истории проверок»",
  ],
  plaqueSession: "Без входа базовый отчёт доступен только в этой сессии.",
  pick: "Уточните выпуск",
  pickFound: (q: string, n: number) => `По запросу «${q}» нашли ${n} ${plural(n, "выпуск", "выпуска", "выпусков")}. Выберите нужный.`,
  pickOrder: "Сначала торгуемые. Данные Мосбиржи.",
  pickNoReg: "—",
  traded: "торгуется",
  notTraded: "не торгуется",
  notFound: "Не нашли бумагу на Мосбирже",
  searched: (q: string) => `Искали: ${q}`,
  notFoundOtc: "Бумага не торгуется на Мосбирже — внебиржевой или погашенный выпуск. Такие мы пока не проверяем.",
  docSoon: "Проверка по документу продавца появится после запуска шлюза обезличивания.",
  err: "Не получилось проверить бумагу",
} as const;

const pct2 = (x: number) => fmt(x, 2) + "%";
const pctMax = (x: number) => fmtMax(x, 2) + "%";
const cap1 = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/* ═══════════════════════════ тон ═══════════════════════════ */

export type Tone = "good" | "mid" | "bad" | "none";

/** Тон по Truth Score — те же пороги, что градации в конфиге движка. */
export function scoreTone(score: number): Tone {
  const [good, mid] = [CONFIG.grades[0][0], CONFIG.grades[1][0]];
  return score >= good ? "good" : score >= mid ? "mid" : "bad";
}

/** Тон метки ликвидности по категории движка; выхода через биржу нет — красный. */
export function liquidityTone(cat: string, noExit: boolean): Tone {
  if (noExit) return "bad";
  return cat === "норм" ? "good" : cat === "умеренно" ? "mid" : cat === "низкая" ? "bad" : "none";
}

/* ═══════════════════════════ типы VM ═══════════════════════════ */

export interface SectionVM {
  id: PanelIdT;
  /** заголовок карточки; пустой — секция продолжает карточку предыдущей (карточка «Доходность») */
  title: string;
  subtitle?: string;
  /** крупная строка секции (см. форму строк в шапке) */
  big?: string;
  tone?: Tone;
  lines: string[];
  /** подпись баров: «Доходность» / «Доходность флоатера по сценариям ставок» */
  barsCaption?: string;
  bars?: { label: string; value: string }[];
  /** пункты (флаги, риски); badge — «−N» баллов флага */
  items?: { title: string; text: string; badge?: string }[];
  /** только ask_price: askPriceNote — текст после отправки формы, где пересчёта нет; до действия пользователя не виден,
   *  поэтому в vmStrings не входит и в Telegram не выводится */
  note?: string;
}

export interface ReportVM {
  dataTime: string | null;
  kicker: string;
  name: string;
  isin: string | null;
  sections: SectionVM[];
  plaque: { title: string; items: string[] } | null;
}

export type PickVM = {
  kind: "pick"; title: string; lines: string[];
  /** label — краткое имя; sub — ISIN или SECID; reg — рег. номер или «—»; trading — «торгуется» / «не торгуется»;
   *  message — реплика выбора (pickMessage), на экране не видна */
  options: { label: string; sub: string; reg: string; trading: string; message: string; traded: boolean }[];
};
export type BranchVM = PickVM | { kind: "notfound" | "err"; title: string; lines: string[] };

type BranchResult = Exclude<BuildResultT, { kind: "report" }>;
type PickResult = Extract<BuildResultT, { kind: "pick" }>;

/** Панели, у которых есть секция VM (data_line — dataTime шапки, plaque — plaque, macro не рисуется) */
export type SectionId = Exclude<PanelIdT, "data_line" | "macro" | "plaque">;

/** Секции в порядке раскладки ReportView */
const LAYOUT: readonly SectionId[] = ["product", "claim", "ask_price", "yield", "price_line", "flags_score", "liquidity", "fees", "worst"];
/** Секции карточки «Доходность» (ReportView: Claim, AskPrice, Yield, PriceLine) */
const YIELD_CARD: readonly SectionId[] = ["claim", "ask_price", "yield", "price_line"];

/* ═══════════════════════════ доходность ═══════════════════════════ */

export type YieldVariant = "single" | "scenarios" | "period_income" | "not_calculated";

/** Вариация блока доходности (data-variant на сайте): period_income без данных периода рисуется как single */
export function yieldVariant(r: BondReportT): YieldVariant {
  const y = r.yield;
  if (y.kind === "not_calculated") return "not_calculated";
  if (y.kind === "period_income") return y.period_income ? "period_income" : "single";
  return y.kind;
}

/** Бар доходности: подпись и значение — текст VM; key и pct — серия и число для ширины полосы и data-атрибутов валидатора */
export interface YieldBar { key: string; label: string; value: string; pct: number }

/** Бары доходности и их подпись; null — баров нет (не рассчитана; доход за период без «обещали») */
export function yieldBars(r: BondReportT): { caption: string; bars: YieldBar[] } | null {
  const y = r.yield;
  const v = yieldVariant(r);
  const claim = r.claim.line != null && r.claim.promised_pct != null;
  const bars: YieldBar[] = [];
  // ввод пользователя («обещали 26%») — как ввели, без принудительных двух знаков
  if (claim) bars.push({ key: "claim", label: T.barPromised, value: pctMax(r.claim.promised_pct!), pct: r.claim.promised_pct! });
  if (v === "not_calculated") return null;
  if (v === "period_income") return claim ? { caption: T.barsYield, bars } : null;
  if (v === "scenarios") {
    y.values.forEach((x, i) => bars.push({ key: "scen" + (i + 1), label: cap1(x.label), value: pct2(x.pct), pct: x.pct }));
    return { caption: T.barsScenarios, bars };
  }
  const main = y.values[0];
  if (main) bars.push({ key: "main", label: claim ? T.barActual : cap1(T.barCalculated + main.label), value: pct2(main.pct), pct: main.pct });
  const post = r.fees_tax.post_tax_pct;
  const k = r.fees_tax.k_pct;
  if (post != null) bars.push({ key: "post", label: k && k > 0 ? T.barPostTaxK : T.barPostTax, value: pct2(post), pct: post });
  return { caption: T.barsYield, bars };
}

/* ═══════════════════════════ секции ═══════════════════════════ */

/** Заголовок секции карточки «Доходность»: у первой её секции из r.panels — «Доходность», у остальных пусто */
function yieldCardTitle(r: BondReportT, id: SectionId): string {
  return YIELD_CARD.find((x) => r.panels.includes(x)) === id ? T.yieldCard : "";
}

/** Секция VM одной панели (та же, что в presentReport). Сайт рисует по ней блок реестра, получая только `r`. */
export function presentSection(r: BondReportT, id: SectionId, o: { askPriceNote?: string } = {}): SectionVM {
  switch (id) {
    case "product": {
      const s = r.status;
      const reason = (s.kind === "not_traded" || s.kind === "structured" || s.kind === "perpetual") && s.reason ? [s.reason] : [];
      return { id, title: T.product, lines: [r.product.plain_text, ...reason] };
    }
    case "claim": {
      const over = r.claim.gap_pp != null && r.claim.gap_pp > CONFIG.flags.gapPp;
      return { id, title: yieldCardTitle(r, id), tone: over ? "bad" : "good", lines: r.claim.line != null ? [r.claim.line] : [] };
    }
    case "ask_price": {
      const s: SectionVM = { id, title: yieldCardTitle(r, id), lines: [T.askPrice] };
      if (o.askPriceNote != null) s.note = o.askPriceNote;
      return s;
    }
    case "yield": {
      const y = r.yield;
      const title = yieldCardTitle(r, id);
      const v = yieldVariant(r);
      if (v === "not_calculated") {
        const s: SectionVM = { id, title, tone: "none", lines: [] };
        if (y.not_calculated_reason != null) s.big = y.not_calculated_reason;
        return s;
      }
      const s: SectionVM = { id, title, lines: y.line != null ? [y.line] : [] };
      if (v === "period_income") {
        const p = y.period_income!;
        s.big = T.periodIncome(fmt(p.gain_pct, 2), p.date, fmt(p.gain_money, 2), r.price.currency === "RUB" ? "₽" : r.price.currency);
      }
      const b = yieldBars(r);
      if (b) {
        s.barsCaption = b.caption;
        s.bars = b.bars.map(({ label, value }) => ({ label, value }));
      }
      return s;
    }
    case "price_line":
      return { id, title: yieldCardTitle(r, id), lines: r.price.line != null ? [r.price.line] : [] };
    case "flags_score": {
      const t = r.truth_score;
      const n = r.flags.length;
      const s: SectionVM = { id, title: T.score, subtitle: T.scoreSub(n), big: T.scoreBig(t.score), tone: scoreTone(t.score), lines: [t.grade] };
      if (t.none_fired) s.lines.push(T.noneFired(n));
      else {
        s.lines.push(T.topFlags);
        s.items = t.top3
          .map((fid) => r.flags.find((f) => f.id === fid))
          .filter((f): f is BondReportT["flags"][number] => f != null)
          .map((f) => ({ title: f.title, text: f.text, badge: T.flagPoints(f.points) }));
        if (t.more_count > 0) s.lines.push(T.moreFlags(t.more_count));
      }
      return s;
    }
    case "liquidity": {
      const L = r.liquidity;
      return {
        id, title: T.liquidity, big: L.no_exit ? T.noExit : cap1(L.category), tone: liquidityTone(L.category, L.no_exit),
        lines: L.metrics_line ? [L.line, L.metrics_line] : [L.line],
      };
    }
    case "fees": {
      const f = r.fees_tax;
      const s: SectionVM = { id, title: T.fees, lines: [f.line ?? "", T.tax(f.tax_note)] };
      if (f.post_tax_pct != null) s.big = `${pct2(f.post_tax_pct)} ${f.k_pct != null && f.k_pct > 0 ? T.postTaxK : T.postTax}`;
      return s;
    }
    case "worst":
      return { id, title: T.worst, lines: [], items: r.worst.map((w) => ({ title: w.title, text: w.text })) };
  }
}

/** Плашка полного отчёта (П23): заголовок и пункты; последний пункт — условие без входа */
export function presentPlaque(): { title: string; items: string[] } {
  return { title: T.plaque, items: [...T.plaqueItems, T.plaqueSession] };
}

/** Строка свежести данных (шапка, data_line, П30) — dataTime VM */
export const presentDataTime = (r: BondReportT): string => r.data_time.line;

/** VM отчёта: шапка, секции по раскладке ReportView (только из r.panels), плашка. askPriceNote — в секцию ask_price (note). */
export function presentReport(r: BondReportT, o: { askPriceNote?: string } = {}): ReportVM {
  const has = (id: PanelIdT) => r.panels.includes(id);
  return {
    dataTime: has("data_line") ? presentDataTime(r) : null,
    kicker: T.kicker,
    name: r.security.shortname,
    isin: r.security.isin,
    sections: LAYOUT.filter(has).map((id) => presentSection(r, id, o)),
    plaque: has("plaque") ? presentPlaque() : null,
  };
}

/* ═══════════════════════════ ветки ═══════════════════════════ */

/** VM ветки распознавания: выбор выпуска, «не нашли», ошибка ввода */
export function presentBranch(res: PickResult): PickVM;
export function presentBranch(res: BranchResult): BranchVM;
export function presentBranch(res: BranchResult): BranchVM {
  if (res.kind === "pick")
    return {
      kind: "pick", title: T.pick, lines: [T.pickFound(res.query, res.candidates.length), T.pickOrder],
      options: res.candidates.map((c) => ({
        label: c.shortname, sub: c.isin ?? c.secid, reg: c.regnumber ?? T.pickNoReg,
        trading: c.is_traded ? T.traded : T.notTraded, message: pickMessage(c), traded: c.is_traded,
      })),
    };
  if (res.kind === "notfound")
    return { kind: "notfound", title: T.notFound, lines: [T.searched(res.query), ...(res.isinValid ? [T.notFoundOtc] : []), T.docSoon] };
  return { kind: "err", title: T.err, lines: [res.msg] };
}

/* ═══════════════════════════ строки ═══════════════════════════ */

/**
 * Все видимые строки VM (TG.6, TG.6-tg): шапка, заголовки, подписи, крупные строки, строки, подписи и значения баров
 * (отдельными строками; составную aria-строку баров не возвращает), пункты и их badge, плашка; у веток — заголовок, строки
 * и у вариантов выбора label, sub, reg, trading. Не входят: note (askPriceNote — видна только после отправки формы) и
 * message вариантов (реплика выбора, на экране её нет). Пустые строки пропускаются.
 */
export function vmStrings(vm: ReportVM | BranchVM): string[] {
  const out: (string | null | undefined)[] = [];
  if ("kind" in vm) {
    out.push(vm.title, ...vm.lines);
    if (vm.kind === "pick") for (const o of vm.options) out.push(o.label, o.sub, o.reg, o.trading);
  } else {
    out.push(vm.dataTime, vm.kicker, vm.name, vm.isin);
    for (const s of vm.sections) {
      out.push(s.title, s.subtitle, s.big, ...s.lines, s.barsCaption);
      for (const b of s.bars ?? []) out.push(b.label, b.value);
      for (const i of s.items ?? []) out.push(i.title, i.text, i.badge);
    }
    if (vm.plaque) out.push(vm.plaque.title, ...vm.plaque.items);
  }
  return out.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}
