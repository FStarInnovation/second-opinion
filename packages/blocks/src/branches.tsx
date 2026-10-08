/**
 * Ветки распознавания 2.3.0: «Уточните выпуск» (pick), «Не нашли» (notfound), ошибка ввода (err).
 * Рисуются из конверта BuildResult движка; фактов в шаблоне нет.
 */
import type { BuildResultT } from "@so/engine/contract";
import { BackIcon, SearchIcon } from "./ui.js";

type Pick = Extract<BuildResultT, { kind: "pick" }>;
type NotFound = Extract<BuildResultT, { kind: "notfound" }>;
type Err = Extract<BuildResultT, { kind: "err" }>;

const variantWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11 ? "выпуск" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "выпуска" : "выпусков";

export function PickView({ res, hrefFor, newCheckHref, onPick }: {
  res: Pick;
  /** Ссылка на отчёт по выпуску (статический демо-режим); null — выпуск ещё не собран. */
  hrefFor?: (secid: string) => string | null;
  onPick?: (secid: string) => void;
  newCheckHref?: string;
}) {
  return (
    <div className="so-main so-main--narrow" data-branch="pick">
      <a className="btn btn-ghost" href={newCheckHref ?? "./"}><BackIcon />Новая проверка</a>
      <div className="so-title">
        <h1 className="so-h1">Уточните выпуск</h1>
        <p className="text">
          По запросу «{res.query}» нашли {res.candidates.length} {variantWord(res.candidates.length)}. Выберите нужный.
        </p>
      </div>
      <section className="card pick" aria-label="Найденные выпуски" data-block="pick">
        <div className="pick__row pick__head" aria-hidden="true">
          <span className="pick__name">Выпуск и ISIN</span><span className="pick__reg">Рег. номер</span>
          <span className="pick__st">Торги</span><span className="pick__act" />
        </div>
        {res.candidates.map((c) => {
          const href = hrefFor ? hrefFor(c.secid) : null;
          return (
            <div key={c.secid} className="pick__row" data-secid={c.secid}>
              <span className="pick__name"><b>{c.shortname}</b><span className="mono cap">{c.isin ?? c.secid}</span></span>
              <span className="pick__reg mono cap">{c.regnumber ?? "—"}</span>
              <span className={"pick__st " + (c.is_traded ? "" : "pick__muted")}>{c.is_traded ? "торгуется" : "не торгуется"}</span>
              <span className="pick__act">
                {href ? (
                  <a className="btn btn-outline" href={href} style={{ width: "100%" }}>Проверить</a>
                ) : (
                  <button type="button" className="btn btn-outline" style={{ width: "100%" }} disabled={!onPick}
                    onClick={() => onPick?.(c.secid)}>Проверить</button>
                )}
              </span>
            </div>
          );
        })}
      </section>
      <p className="cap">Сначала торгуемые. Данные Мосбиржи.</p>
    </div>
  );
}

export function NotFoundView({ res, newCheckHref }: { res: NotFound; newCheckHref?: string }) {
  return (
    <div className="so-main so-main--tiny" data-branch="notfound">
      <section className="card so-404" data-block="notfound" aria-labelledby="h-404">
        <span className="so-404__icon"><SearchIcon /></span>
        <div className="stack" style={{ gap: 8 }}>
          <h1 id="h-404" style={{ fontSize: 28, lineHeight: 1.2, fontWeight: 700, letterSpacing: "-0.02em" }}>Не нашли бумагу на Мосбирже</h1>
          <p className="text">Искали: <strong className="mono" style={{ color: "#0f172a", wordBreak: "break-all" }}>{res.query}</strong></p>
          {res.isinValid ? (
            <p className="text">Бумага не торгуется на Мосбирже — внебиржевой или погашенный выпуск. Такие мы пока не проверяем.</p>
          ) : null}
        </div>
        <div className="row-btns">
          <a className="btn btn-primary btn-lg" href={newCheckHref ?? "./"}>Проверить ISIN</a>
          <button type="button" className="btn btn-outline btn-lg" disabled title="Вход файлом — после MVP">Загрузить документ продавца</button>
        </div>
        <p className="cap">Проверка по документу продавца появится после запуска шлюза обезличивания.</p>
      </section>
    </div>
  );
}

export function ErrView({ res, newCheckHref }: { res: Err; newCheckHref?: string }) {
  return (
    <div className="so-main so-main--tiny" data-branch="err">
      <section className="card so-404" data-block="err">
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Не получилось распознать запрос</h1>
        <p className="text">{res.msg}</p>
        <a className="btn btn-primary btn-lg" href={newCheckHref ?? "./"}>Новая проверка</a>
      </section>
    </div>
  );
}
