/**
 * Примитивы блоков. Форматирование — только отображение готовых чисел контракта (ru-RU),
 * никакой арифметики методики здесь нет (инвариант 3).
 */
import type { ReactNode } from "react";
import { fmt, fmtMax } from "@so/engine/format";
import { CONFIG } from "@so/engine/config";

export type Tone = "good" | "mid" | "bad" | "none";

/** Тон по Truth Score — те же пороги, что градации в конфиге движка. */
export function scoreTone(score: number): Tone {
  const [good, mid] = [CONFIG.grades[0][0], CONFIG.grades[1][0]];
  return score >= good ? "good" : score >= mid ? "mid" : "bad";
}

export function liquidityTone(cat: string, noExit: boolean): Tone {
  if (noExit) return "bad";
  return cat === "норм" ? "good" : cat === "умеренно" ? "mid" : cat === "низкая" ? "bad" : "none";
}

export const pct2 = (x: number) => fmt(x, 2) + "%";
export const pctMax = (x: number) => fmtMax(x, 2) + "%";
export const cap1 = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function Card(props: { id: string; title?: ReactNode; sub?: ReactNode; className?: string; block?: string; children: ReactNode }) {
  const h = props.title ? `h-${props.id}` : undefined;
  return (
    <section className={"card" + (props.className ? " " + props.className : "")} aria-labelledby={h} data-block={props.block}>
      {props.title ? (
        props.sub ? (
          <div className="card__sub">
            <h2 id={h}>{props.title}</h2>
            <span className="cap">{props.sub}</span>
          </div>
        ) : (
          <h2 id={h}>{props.title}</h2>
        )
      ) : null}
      {props.children}
    </section>
  );
}

export interface BarDatum {
  key: string; label: string; value: number; color: string;
  /** Ввод пользователя («обещали 26%») показываем как ввели, без принудительных двух знаков. */
  exact?: boolean;
}

/**
 * Горизонтальные бары доходности. Шкала — от нуля до максимума показанных значений
 * (шкалу не растягиваем). Для валидатора: у графика есть aria-label, каждая подпись
 * (data-legend-for) ссылается на нарисованную серию (data-series).
 */
export function Bars({ data, caption }: { data: BarDatum[]; caption: string }) {
  const max = Math.max(0, ...data.map((d) => d.value));
  const show = (d: BarDatum) => (d.exact ? pctMax(d.value) : pct2(d.value));
  const aria = caption + ": " + data.map((d) => `${d.label} ${show(d)}`).join(", ");
  return (
    <div className="bars" role="img" aria-label={aria} data-chart="yield-bars">
      {data.map((d) => {
        const w = max > 0 && d.value > 0 ? (d.value / max) * 100 : 0;
        return (
          <div key={d.key} aria-hidden="true">
            <div className="bar__head">
              <span className="bar__label" data-legend-for={w > 0 ? d.key : undefined}>{d.label}</span>
              <span className="bar__val">{show(d)}</span>
            </div>
            {w > 0 ? (
              <div className="bar__track">
                <div className="bar__fill" data-series={d.key} style={{ width: w.toFixed(1) + "%", background: d.color }} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export const LockIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#353d64" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "0 0 auto", marginTop: 3 }}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

export const BackIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

export const SearchIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#353d64" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2" />
  </svg>
);

export const BrandMark = () => (
  <svg width="27" height="32" viewBox="0 0 127 148" fill="none" aria-hidden="true">
    <path d="M68.7917 52.9822H91.7222V102.462C83.5041 106.797 78.5023 108.921 68.7917 112.095V52.9822Z" fill="#A9C6E6" />
    <path d="M95.691 28.4615L124.795 0V52.9822C122.475 67.6143 117.913 75.439 105.392 88.8876V28.4615H95.691Z" fill="#96B4D6" />
    <path d="M0 148C6.61458 134.864 48.9479 127.42 48.9479 127.42C48.9479 127.42 115.535 116.473 127 66.9941C124.996 114.056 97.0139 144.497 74.5243 144.497C52.0347 144.497 15.1135 144.837 0 148Z" fill="#96C0E0" />
    <path d="M34.3958 77.0651H56.0035V115.598L25.5764 124.793C31.1475 116.228 32.7495 111.314 34.3958 102.462V77.0651Z" fill="#CFE5F8" />
  </svg>
);
