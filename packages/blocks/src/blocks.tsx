"use client";
/**
 * Блоки реестра (dev-док «Генеративная сборка страницы бумаги», раздел «Реестр блоков»).
 * Каждый блок — чистая функция от контракта bond_report@1: ничего не считает по методике,
 * только показывает готовые числа и фразы движка. Корневой элемент помечен data-block=<id>
 * — по нему валидатор сверяет отрисованное с panels.
 */
import { useState, type FormEvent } from "react";
import type { BondReportT, ReportInputs } from "@so/engine/contract";
import { CONFIG } from "@so/engine/config";
import { fmt, fmtMax } from "@so/engine/format";
import { Bars, Card, LockIcon, cap1, liquidityTone, pct2, pctMax, scoreTone, type BarDatum } from "./ui";

type R = BondReportT;

/* data_line — строка свежести данных (П30) */
export function DataLine({ r }: { r: R }) {
  return <p className="cap" data-block="data_line">{r.data_time.line}</p>;
}

/* product — «что это за продукт простыми словами» (П5) */
export function Product({ r }: { r: R }) {
  return (
    <Card id="product" block="product" title="Что это за продукт простыми словами">
      <p className="lead">{r.product.plain_text}</p>
      {(r.status.kind === "not_traded" || r.status.kind === "structured" || r.status.kind === "perpetual") && r.status.reason
        ? <p className="note note--bad">{r.status.reason}</p> : null}
    </Card>
  );
}

/* claim — «Обещали · На самом деле · Разница» (П6); красный при разнице больше порога флага 12 */
export function Claim({ r }: { r: R }) {
  const over = r.claim.gap_pp != null && r.claim.gap_pp > CONFIG.flags.gapPp;
  return (
    <p data-block="claim" className={over ? "tone-bad" : "tone-good"} style={{ fontSize: 17, lineHeight: 1.4, fontWeight: 600 }}>
      {r.claim.line}
    </p>
  );
}

/* yield — четыре вариации: single / scenarios / period_income / not_calculated */
export function Yield({ r }: { r: R }) {
  const y = r.yield;
  const claim = r.claim.line != null && r.claim.promised_pct != null;
  const bars: BarDatum[] = [];
  if (claim) bars.push({ key: "claim", label: "Обещали", value: r.claim.promised_pct!, color: "#94a3b8", exact: true });

  if (y.kind === "not_calculated") {
    return (
      <div data-block="yield" data-variant="not_calculated" className="stack">
        <p className="big tone-none">{y.not_calculated_reason}</p>
      </div>
    );
  }

  if (y.kind === "period_income" && y.period_income) {
    const p = y.period_income;
    return (
      <div data-block="yield" data-variant="period_income" className="stack">
        <div className="stat">
          <span className="stat__v">+{fmt(p.gain_pct, 2)}%</span>
          <span className="stat__u">за период до колла {p.date} — {fmt(p.gain_money, 2)} {r.price.currency === "RUB" ? "₽" : r.price.currency} на облигацию</span>
        </div>
        {claim ? <Bars caption="Доходность" data={bars} /> : null}
        <p className="text">{y.line}</p>
      </div>
    );
  }

  if (y.kind === "scenarios") {
    const colors = ["#353d64", "#6b77a6", "#94a3b8"];
    y.values.forEach((v, i) => bars.push({ key: "scen" + (i + 1), label: cap1(v.label), value: v.pct, color: colors[i] ?? "#94a3b8" }));
    return (
      <div data-block="yield" data-variant="scenarios" className="stack">
        <Bars caption="Доходность флоатера по сценариям ставок" data={bars} />
        <p className="text">{y.line}</p>
      </div>
    );
  }

  // single
  const main = y.values[0];
  if (main) bars.push({ key: "main", label: claim ? "На самом деле" : cap1("расчётная " + main.label), value: main.pct, color: "#353d64" });
  const post = r.fees_tax.post_tax_pct;
  const k = r.fees_tax.k_pct;
  if (post != null) bars.push({ key: "post", label: k && k > 0 ? "После комиссии и налога" : "После налога", value: post, color: "#6b77a6" });
  return (
    <div data-block="yield" data-variant="single" className="stack">
      <Bars caption="Доходность" data={bars} />
      <p className="text">{y.line}</p>
    </div>
  );
}

/* price_line — из чего сложилась цена покупки (П7) */
export function PriceLine({ r }: { r: R }) {
  return <p className="cap" data-block="price_line">{r.price.line}</p>;
}

/* ask_price — ветка «нет цены»: спросить цену предложения, потом полная пересборка движком */
export function AskPrice({ r, onSubmit, unavailableNote }: {
  r: R; onSubmit?: (pricePct: number) => void; unavailableNote?: string;
}) {
  const [v, setV] = useState(r.inputs.offer_price_pct != null ? fmtMax(r.inputs.offer_price_pct, 2) : "");
  const [msg, setMsg] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(n) || n <= 0 || n > 300) { setMsg("Укажите цену в процентах от номинала, например 98,5"); return; }
    if (!onSubmit) { setMsg(unavailableNote ?? "Пересчёт по вашей цене недоступен на этой странице."); return; }
    setMsg(null);
    onSubmit(n);
  };
  return (
    <form data-block="ask_price" className="stack" onSubmit={submit} noValidate>
      <p className="text">
        По бумаге не было сделок, поэтому биржевой цены нет. Укажите цену из предложения продавца — посчитаем доходность от неё.
      </p>
      <div className="inputs__field" style={{ flex: "0 1 auto" }}>
        <label htmlFor="ask-price" className="lbl">По какой цене вам предлагают купить? % от номинала</label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {/* ym-hide-content ym-disable-keys — Вебвизор Метрики не записывает ввод (так у всех полей отчёта) */}
          <input id="ask-price" className="inp ym-hide-content ym-disable-keys" inputMode="decimal" autoComplete="off" placeholder="например, 98,5"
            value={v} onChange={(e) => setV(e.target.value)} style={{ flex: "1 1 160px" }} />
          <button type="submit" className="btn btn-primary btn-lg" style={{ flex: "0 0 auto" }}>Посчитать</button>
        </div>
      </div>
      {msg ? <p className="note" role="status">{msg}</p> : null}
    </form>
  );
}

/* liquidity — категория, выход на вашу позицию (П13–П16) */
export function Liquidity({ r }: { r: R }) {
  const L = r.liquidity;
  const tone = liquidityTone(L.category, L.no_exit);
  return (
    <Card id="liq" block="liquidity" title="Ликвидность">
      <span className={"big tone-" + tone}>{L.no_exit ? "Выйти через биржу сейчас нельзя" : cap1(L.category)}</span>
      <p className="text">{L.line}</p>
      {L.metrics_line ? <p className="cap push-down">{L.metrics_line}</p> : null}
    </Card>
  );
}

/* fees — комиссия брокера и налог (П17) */
export function Fees({ r }: { r: R }) {
  const f = r.fees_tax;
  const withK = f.k_pct != null && f.k_pct > 0;
  return (
    <Card id="fee" block="fees" title="Комиссии и налог">
      {f.post_tax_pct != null ? (
        <span className="big">
          {pct2(f.post_tax_pct)} <span className="stat__u" style={{ fontWeight: 500 }}>{withK ? "после комиссии и налога" : "после налога"}</span>
        </span>
      ) : null}
      <p className="text">{f.line}</p>
      <p className="cap push-down">Налог {f.tax_note}. Скрытых комиссий в структуре обычной облигации нет.</p>
    </Card>
  );
}

/* worst — только применимые риски (П18) */
export function Worst({ r }: { r: R }) {
  return (
    <Card id="worst" block="worst" title="Worst-case">
      {r.worst.map((w) => (
        <div key={w.id} className="risk" data-risk={w.id}>
          <span className="risk__t">{w.title}</span>
          <span className="risk__x">{w.text}</span>
        </div>
      ))}
    </Card>
  );
}

/* flags_score — Truth Score, градация, три главных флага (П22) */
export function FlagsScore({ r }: { r: R }) {
  const t = r.truth_score;
  const tone = scoreTone(t.score);
  const top = t.top3.map((id) => r.flags.find((f) => f.id === id)!).filter(Boolean);
  return (
    <Card id="score" block="flags_score" title="Product Truth Score" sub={`100 минус баллы за сработавшие red flags (${r.flags.length} правил)`}>
      <div className="score">
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span className={"score__n tone-" + tone} data-score>{t.score}</span>
          <span className="score__of">/ 100</span>
        </div>
        <span className={"pill tone-" + tone} data-grade>{t.grade}</span>
      </div>
      {t.none_fired ? (
        <p className="note note--good">{`Ни один из ${r.flags.length} red flags не сработал.`}</p>
      ) : (
        <div>
          <span className="cap" style={{ display: "block", paddingBottom: 6 }}>Главные red flags</span>
          {top.map((f) => (
            <div key={f.id} className="flag" data-flag={f.id} data-points={f.points}>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span className="flag__t">{f.title}</span>
                <span className="flag__d">{f.text}</span>
              </span>
              <span className="flag__p mono">−{f.points}</span>
            </div>
          ))}
          {t.more_count > 0 ? (
            <p className="cap" style={{ paddingTop: 8, borderTop: "1px solid #e2e8f0" }}>Ещё {t.more_count} — в полном отчёте</p>
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

/* plaque — плашка полного отчёта, текст по решению П23 */
export const PLAQUE_ITEMS = [
  "Короткое объяснение и что важно знать перед покупкой",
  "Скоринг продукта и оценка под ваши цели",
  "Вопросы, которые стоит задать продавцу",
  "Отчёт сохранится в «Истории проверок»",
];
export function Plaque({ cabinetHref }: { cabinetHref: string }) {
  return (
    <section className="card plaque" aria-labelledby="h-plaque" data-block="plaque">
      <div className="stack">
        <h2 id="h-plaque" style={{ fontSize: 20 }}>Полный отчёт — после входа</h2>
        <ul>
          {PLAQUE_ITEMS.map((t) => (
            <li key={t}><LockIcon /><span>{t}</span></li>
          ))}
        </ul>
      </div>
      <div className="plaque__cta">
        <a className="btn btn-primary btn-lg" href={cabinetHref} target="_blank" rel="noopener">Войти и получить полный отчёт</a>
        <p>Без входа базовый отчёт доступен только в этой сессии.</p>
      </div>
    </section>
  );
}

/* Ввод пользователя: позиция, комиссия брокера, «обещали». Не блок реестра — элемент шаблона;
   показывается, когда в panels есть зависимые от ввода блоки. */
const presetLabel = (n: number) => (n >= 1e6 ? fmtMax(n / 1e6, 1) + " млн" : fmtMax(n / 1e3, 0) + " тыс");
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
        <h2 id="h-pos" className="lbl">Сколько планируете вложить, ₽</h2>
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
        <label htmlFor="in-pos" className="cap">Своя сумма</label>
        <input id="in-pos" className="inp ym-hide-content ym-disable-keys" inputMode="numeric" autoComplete="off" value={posS} disabled={disabled}
          onChange={(e) => {
            setPosS(e.target.value);
            const n = parseNum(e.target.value);
            if (n != null && Number.isFinite(n) && n >= 1000 && n <= 1e10) send({ position_size: Math.round(n) });
          }} />
      </div>
      {r.panels.includes("fees") ? (
        <div className="inputs__field">
          <label htmlFor="in-k" className="cap">Комиссия брокера, % от суммы сделки</label>
          <input id="in-k" className="inp ym-hide-content ym-disable-keys" inputMode="decimal" autoComplete="off" placeholder="например, 0,3" value={kS} disabled={disabled}
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
          <label htmlFor="in-pr" className="cap">Сколько обещали, % годовых</label>
          <input id="in-pr" className="inp ym-hide-content ym-disable-keys" inputMode="decimal" autoComplete="off" placeholder="например, 18" value={prS} disabled={disabled}
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

export { pctMax };
