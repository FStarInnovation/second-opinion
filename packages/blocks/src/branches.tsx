"use client";
/**
 * Ветки распознавания 2.3.0: «Уточните выпуск» (pick), «Не нашли» (notfound), ошибка ввода (err).
 * Рисуются из конверта BuildResult движка; фактов в шаблоне нет. Тексты — из view-model ветки (presentBranch, @so/present/report),
 * литералы кнопок и подписей таблицы — WEB (@so/present/copy).
 */
import type { BuildResultT } from "@so/engine/contract";
import { WEB } from "@so/present/copy";
import { presentBranch } from "@so/present/report";
import { BackIcon, SearchIcon, splitFirst } from "./ui";

type Pick = Extract<BuildResultT, { kind: "pick" }>;
type NotFound = Extract<BuildResultT, { kind: "notfound" }>;
type Err = Extract<BuildResultT, { kind: "err" }>;

export function PickView({ res, hrefFor, newCheckHref, onPick, compact }: {
  res: Pick;
  /** Ссылка на отчёт по выпуску (страница /check, статический демо-режим); null — выпуск ещё не собран. */
  hrefFor?: (secid: string) => string | null;
  /** Выбор без перехода по ссылке (чат: реплика в тот же диалог). Без hrefFor и onPick кнопка неактивна. */
  onPick?: (secid: string) => void;
  newCheckHref?: string;
  /** В чате кнопка «Новая проверка» не нужна: выбор и новый запрос — в том же диалоге. */
  compact?: boolean;
}) {
  const vm = presentBranch(res);
  const [found, order] = vm.lines;
  return (
    <div className="so-main so-main--narrow" data-branch="pick">
      {!compact ? <a className="btn btn-ghost" href={newCheckHref ?? "./"}><BackIcon />{WEB.newCheck}</a> : null}
      <div className="so-title">
        <h1 className="so-h1">{vm.title}</h1>
        <p className="text">{found}</p>
      </div>
      <section className="card pick" aria-label={WEB.pickAria} data-block="pick">
        <div className="pick__row pick__head" aria-hidden="true">
          <span className="pick__name">{WEB.pickHeadName}</span><span className="pick__reg">{WEB.pickHeadReg}</span>
          <span className="pick__st">{WEB.pickHeadTrading}</span><span className="pick__act" />
        </div>
        {res.candidates.map((c, i) => {
          const o = vm.options[i];
          const href = hrefFor ? hrefFor(c.secid) : null;
          return (
            <div key={c.secid} className="pick__row" data-secid={c.secid}>
              <span className="pick__name"><b>{o.label}</b><span className="mono cap">{o.sub}</span></span>
              <span className="pick__reg mono cap">{o.reg}</span>
              <span className={"pick__st " + (o.traded ? "" : "pick__muted")}>{o.trading}</span>
              <span className="pick__act">
                {href ? (
                  <a className="btn btn-outline" href={href} style={{ width: "100%" }}>{WEB.pickCheck}</a>
                ) : (
                  <button type="button" className="btn btn-outline" style={{ width: "100%" }} disabled={!onPick}
                    onClick={() => onPick?.(c.secid)}>{WEB.pickCheck}</button>
                )}
              </span>
            </div>
          );
        })}
      </section>
      <p className="cap">{order}</p>
    </div>
  );
}

/** compact — в чате: ссылки «Проверить ISIN» на главную нет, новый запрос пишут в тот же диалог (сумма и комиссия сессии сохраняются). */
export function NotFoundView({ res, newCheckHref, compact }: { res: NotFound; newCheckHref?: string; compact?: boolean }) {
  const vm = presentBranch(res);
  // строки VM: «Искали: <запрос>», пояснения (необязательные), сноска о документе продавца — последней
  const [searched, query] = splitFirst(vm.lines[0] ?? "");
  const notes = vm.lines.slice(1, -1);
  const doc = vm.lines.length > 1 ? vm.lines[vm.lines.length - 1] : null;
  return (
    <div className="so-main so-main--tiny" data-branch="notfound">
      <section className="card so-404" data-block="notfound" aria-labelledby="h-404">
        <span className="so-404__icon"><SearchIcon /></span>
        <div className="stack" style={{ gap: 8 }}>
          <h1 id="h-404" style={{ fontSize: 28, lineHeight: 1.2, fontWeight: 700, letterSpacing: "-0.02em" }}>{vm.title}</h1>
          <p className="text">{searched + " "}<strong className="mono" style={{ color: "#0f172a", wordBreak: "break-all" }}>{query}</strong></p>
          {notes.map((t) => (
            <p key={t} className="text">{t}</p>
          ))}
        </div>
        <div className="row-btns">
          {!compact ? <a className="btn btn-primary btn-lg" href={newCheckHref ?? "./"}>{WEB.checkIsin}</a> : null}
          <button type="button" className="btn btn-outline btn-lg" disabled title={WEB.uploadDocTitle}>{WEB.uploadDoc}</button>
        </div>
        <p className="cap">{doc}</p>
      </section>
    </div>
  );
}

/** compact — в чате: без кнопки «Новая проверка» на главную, повторить запрос можно в том же диалоге. */
export function ErrView({ res, newCheckHref, compact }: { res: Err; newCheckHref?: string; compact?: boolean }) {
  const vm = presentBranch(res);
  return (
    <div className="so-main so-main--tiny" data-branch="err">
      <section className="card so-404" data-block="err">
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>{vm.title}</h1>
        <p className="text">{vm.lines[0]}</p>
        {!compact ? <a className="btn btn-primary btn-lg" href={newCheckHref ?? "./"}>{WEB.newCheck}</a> : null}
      </section>
    </div>
  );
}
