"use client";
/**
 * Блоки реестра (dev-док «Генеративная сборка страницы бумаги», раздел «Реестр блоков»).
 * Каждый блок — чистая функция от контракта bond_report@1: ничего не считает по методике,
 * только показывает готовые числа и фразы движка. Все тексты, отформатированные числа и тон блока — из его секции
 * view-model (presentSection, @so/present/report — та же, что в presentReport и у Telegram-бота, И3); из r берутся только
 * вариации и значения для разметки и data-атрибутов. Литералы форм ввода и кнопок — WEB (@so/present/copy).
 * Корневой элемент помечен data-block=<id> — по нему валидатор сверяет отрисованное с panels.
 */
import { useState, type FormEvent } from "react";
import { ReportInputsSchema, type BondReportT, type ReportInputs } from "@so/engine/contract";
import { CONFIG } from "@so/engine/config";
import { fmtMax } from "@so/engine/format";
import { WEB } from "@so/present/copy";
import { presentDataTime, presentPlaque, presentSection, yieldBars, yieldVariant } from "@so/present/report";
import { Bars, Card, LockIcon, splitFirst, type BarDatum } from "./ui";

type R = BondReportT;

/* data_line — строка свежести данных (П30) */
export function DataLine({ r }: { r: R }) {
  return <p className="cap" data-block="data_line">{presentDataTime(r)}</p>;
}

/* product — «что это за продукт простыми словами» (П5) */
export function Product({ r }: { r: R }) {
  const s = presentSection(r, "product");
  const [lead, reason] = s.lines;
  return (
    <Card id="product" block="product" title={s.title}>
      <p className="lead">{lead}</p>
      {reason ? <p className="note note--bad">{reason}</p> : null}
    </Card>
  );
}

/* claim — «Обещали · На самом деле · Разница» (П6); красный при разнице больше порога флага 12 (тон — из VM) */
export function Claim({ r }: { r: R }) {
  const s = presentSection(r, "claim");
  return (
    <p data-block="claim" className={"tone-" + s.tone} style={{ fontSize: 17, lineHeight: 1.4, fontWeight: 600 }}>
      {s.lines[0]}
    </p>
  );
}

/** Цвета серий баров доходности */
const BAR_COLOR: Record<string, string> = {
  claim: "#94a3b8", main: "#353d64", post: "#6b77a6", scen1: "#353d64", scen2: "#6b77a6", scen3: "#94a3b8",
};
const OTHER_BAR = "#94a3b8";

/* yield — четыре вариации: single / scenarios / period_income / not_calculated */
export function Yield({ r }: { r: R }) {
  const s = presentSection(r, "yield");
  const variant = yieldVariant(r);
  if (variant === "not_calculated") {
    return (
      <div data-block="yield" data-variant="not_calculated" className="stack">
        <p className={"big tone-" + s.tone}>{s.big}</p>
      </div>
    );
  }
  const data: BarDatum[] = (yieldBars(r)?.bars ?? []).map((b) => ({ ...b, color: BAR_COLOR[b.key] ?? OTHER_BAR }));
  const bars = s.barsCaption != null ? <Bars caption={s.barsCaption} data={data} /> : null;
  if (variant === "period_income") {
    const [gain, period] = splitFirst(s.big ?? "");
    return (
      <div data-block="yield" data-variant="period_income" className="stack">
        <div className="stat">
          <span className="stat__v">{gain}</span>
          <span className="stat__u">{period}</span>
        </div>
        {bars}
        <p className="text">{s.lines[0]}</p>
      </div>
    );
  }
  return (
    <div data-block="yield" data-variant={variant} className="stack">
      {bars}
      <p className="text">{s.lines[0]}</p>
    </div>
  );
}

/* price_line — из чего сложилась цена покупки (П7) */
export function PriceLine({ r }: { r: R }) {
  return <p className="cap" data-block="price_line">{presentSection(r, "price_line").lines[0]}</p>;
}

/** Цена предложения — по той же схеме, что /api/report, /check и инструменты ассистента (И4): иначе цена 0 < p < 1 ушла бы
 *  на сервер и вернулась ошибкой */
const OFFER_PRICE = ReportInputsSchema.shape.offer_price_pct;

/* ask_price — ветка «нет цены»: спросить цену предложения, потом полная пересборка движком */
export function AskPrice({ r, onSubmit, unavailableNote }: {
  r: R; onSubmit?: (pricePct: number) => void; unavailableNote?: string;
}) {
  const s = presentSection(r, "ask_price", { askPriceNote: unavailableNote });
  const [v, setV] = useState(r.inputs.offer_price_pct != null ? fmtMax(r.inputs.offer_price_pct, 2) : "");
  const [msg, setMsg] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    if (!OFFER_PRICE.safeParse(n).success || n == null) { setMsg(WEB.askPriceInvalid); return; }
    if (!onSubmit) { setMsg(s.note ?? WEB.askPriceUnavailable); return; }
    setMsg(null);
    onSubmit(n);
  };
  return (
    <form data-block="ask_price" className="stack" onSubmit={submit} noValidate>
      <p className="text">{s.lines[0]}</p>
      <div className="inputs__field" style={{ flex: "0 1 auto" }}>
        <label htmlFor="ask-price" className="lbl">{WEB.askPriceLabel}</label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input id="ask-price" className="inp" inputMode="decimal" autoComplete="off" placeholder={WEB.askPricePlaceholder}
            value={v} onChange={(e) => setV(e.target.value)} style={{ flex: "1 1 160px" }} />
          <button type="submit" className="btn btn-primary btn-lg" style={{ flex: "0 0 auto" }}>{WEB.askPriceSubmit}</button>
        </div>
      </div>
      {msg ? <p className="note" role="status">{msg}</p> : null}
    </form>
  );
}

/* liquidity — категория, выход на вашу позицию (П13–П16) */
export function Liquidity({ r }: { r: R }) {
  const s = presentSection(r, "liquidity");
  const [line, metrics] = s.lines;
  return (
    <Card id="liq" block="liquidity" title={s.title}>
      <span className={"big tone-" + s.tone}>{s.big}</span>
      <p className="text">{line}</p>
      {metrics ? <p className="cap push-down">{metrics}</p> : null}
    </Card>
  );
}

/* fees — комиссия брокера и налог (П17) */
export function Fees({ r }: { r: R }) {
  const s = presentSection(r, "fees");
  const [line, tax] = s.lines;
  const [value, label] = splitFirst(s.big ?? "");
  return (
    <Card id="fee" block="fees" title={s.title}>
      {s.big != null ? (
        <span className="big">
          {value} <span className="stat__u" style={{ fontWeight: 500 }}>{label}</span>
        </span>
      ) : null}
      <p className="text">{line}</p>
      <p className="cap push-down">{tax}</p>
    </Card>
  );
}

/* worst — только применимые риски (П18) */
export function Worst({ r }: { r: R }) {
  const s = presentSection(r, "worst");
  return (
    <Card id="worst" block="worst" title={s.title}>
      {r.worst.map((w, i) => (
        <div key={w.id} className="risk" data-risk={w.id}>
          <span className="risk__t">{s.items?.[i]?.title}</span>
          <span className="risk__x">{s.items?.[i]?.text}</span>
        </div>
      ))}
    </Card>
  );
}

/* flags_score — Truth Score, градация, три главных флага (П22) */
export function FlagsScore({ r }: { r: R }) {
  const t = r.truth_score;
  const s = presentSection(r, "flags_score");
  const [score, outOf] = splitFirst(s.big ?? "");
  const [grade, head, more] = s.lines;
  // флаги — в порядке items VM (top3); из r — только id и баллы для data-атрибутов валидатора
  const top = t.top3.map((id) => r.flags.find((f) => f.id === id)!).filter(Boolean);
  return (
    <Card id="score" block="flags_score" title={s.title} sub={s.subtitle}>
      <div className="score">
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span className={"score__n tone-" + s.tone} data-score>{score}</span>
          <span className="score__of">{outOf}</span>
        </div>
        <span className={"pill tone-" + s.tone} data-grade>{grade}</span>
      </div>
      {t.none_fired ? (
        <p className="note note--good">{head}</p>
      ) : (
        <div>
          <span className="cap" style={{ display: "block", paddingBottom: 6 }}>{head}</span>
          {top.map((f, i) => (
            <div key={f.id} className="flag" data-flag={f.id} data-points={f.points}>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span className="flag__t">{s.items?.[i]?.title}</span>
                <span className="flag__d">{s.items?.[i]?.text}</span>
              </span>
              <span className="flag__p mono">{s.items?.[i]?.badge}</span>
            </div>
          ))}
          {more ? (
            <p className="cap" style={{ paddingTop: 8, borderTop: "1px solid #e2e8f0" }}>{more}</p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/* macro — после согласования дополнения к П29; в bond_report@1 всегда null, блок не рисуется */
export function Macro(_: { r: R }) {
  return null;
}

/* plaque — плашка полного отчёта, текст по решению П23 (VM: пункты, последний — условие без входа) */
const PLAQUE = presentPlaque();
export const PLAQUE_ITEMS = PLAQUE.items.slice(0, -1);
export function Plaque({ cabinetHref }: { cabinetHref: string }) {
  return (
    <section className="card plaque" aria-labelledby="h-plaque" data-block="plaque">
      <div className="stack">
        <h2 id="h-plaque" style={{ fontSize: 20 }}>{PLAQUE.title}</h2>
        <ul>
          {PLAQUE_ITEMS.map((t) => (
            <li key={t}><LockIcon /><span>{t}</span></li>
          ))}
        </ul>
      </div>
      <div className="plaque__cta">
        <a className="btn btn-primary btn-lg" href={cabinetHref} target="_blank" rel="noopener">{WEB.plaqueCta}</a>
        <p>{PLAQUE.items[PLAQUE.items.length - 1]}</p>
      </div>
    </section>
  );
}

/* Ввод пользователя: позиция, комиссия брокера, «обещали». Не блок реестра — элемент шаблона;
   показывается, когда в panels есть зависимые от ввода блоки. */
const presetLabel = (n: number) => (n >= 1e6 ? fmtMax(n / 1e6, 1) + " " + WEB.presetMillion : fmtMax(n / 1e3, 0) + " " + WEB.presetThousand);
const parseNum = (s: string) => {
  const t = s.replace(/\s| /g, "").replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

export function InputsPanel({ r, onInputs }: { r: R; onInputs?: (i: ReportInputs) => void }) {
  const pos = r.inputs.position_size;
  const [posS, setPosS] = useState(fmtMax(pos, 0));
  const [kS, setKS] = useState(r.inputs.k_pct != null ? fmtMax(r.inputs.k_pct, 2) : "");
  const [prS, setPrS] = useState(r.inputs.promised_pct != null ? fmtMax(r.inputs.promised_pct, 2) : "");
  const disabled = !onInputs;
  const send = (i: ReportInputs) => onInputs?.(i);
  return (
    <section className="card inputs" aria-labelledby="h-pos" data-inputs>
      <div className="inputs__pos">
        <h2 id="h-pos" className="lbl">{WEB.inputsPosition}</h2>
        <div className="segs">
          {CONFIG.positionPresets.map((p) => (
            <button key={p} type="button" className="seg" aria-pressed={pos === p} disabled={disabled} data-preset={p}
              onClick={() => { setPosS(fmtMax(p, 0)); send({ position_size: p }); }}>
              {presetLabel(p)}
            </button>
          ))}
        </div>
      </div>
      <div className="inputs__field">
        <label htmlFor="in-pos" className="cap">{WEB.inputsPositionOwn}</label>
        <input id="in-pos" className="inp" inputMode="numeric" autoComplete="off" value={posS} disabled={disabled}
          onChange={(e) => {
            setPosS(e.target.value);
            const n = parseNum(e.target.value);
            if (n != null && Number.isFinite(n) && n >= 1000 && n <= 1e10) send({ position_size: Math.round(n) });
          }} />
      </div>
      {r.panels.includes("fees") ? (
        <div className="inputs__field">
          <label htmlFor="in-k" className="cap">{WEB.inputsK}</label>
          <input id="in-k" className="inp" inputMode="decimal" autoComplete="off" placeholder={WEB.inputsKPlaceholder} value={kS} disabled={disabled}
            onChange={(e) => {
              setKS(e.target.value);
              const n = parseNum(e.target.value);
              if (n === null) send({ k_pct: null });
              else if (Number.isFinite(n) && n >= 0 && n <= CONFIG.kMax) send({ k_pct: n });
            }} />
        </div>
      ) : null}
      {r.yield.main_pct != null ? (
        // «обещали» сравнивается с расчётной доходностью — без неё поле бессмысленно (нет цены / ставки)
        <div className="inputs__field">
          <label htmlFor="in-pr" className="cap">{WEB.inputsPromised}</label>
          <input id="in-pr" className="inp" inputMode="decimal" autoComplete="off" placeholder={WEB.inputsPromisedPlaceholder} value={prS} disabled={disabled}
            onChange={(e) => {
              setPrS(e.target.value);
              const n = parseNum(e.target.value);
              if (n === null) send({ promised_pct: null });
              else if (Number.isFinite(n) && n > 0 && n <= 100) send({ promised_pct: n });
            }} />
        </div>
      ) : null}
    </section>
  );
}

