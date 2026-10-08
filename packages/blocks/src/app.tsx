"use client";
/**
 * Корень страницы: шапка сайта + результат build(). Состояние ввода живёт здесь,
 * пересчёт — функцией движка applyInputs (та же, что на сервере; паритет проверяет selftest).
 */
import { useCallback, useState } from "react";
import type { BuildResultT, ReportInputs } from "@so/engine/contract";
import { applyInputs } from "@so/engine/inputs";
import { ReportView, CABINET_HREF } from "./ReportView";
import { ErrView, NotFoundView, PickView } from "./branches";
import { BrandMark } from "./ui";

export function SiteHeader({ homeHref, cabinetHref }: { homeHref?: string; cabinetHref?: string }) {
  return (
    <header className="so-header">
      <div className="so-header__in">
        <a className="so-brand" href={homeHref ?? "./"} aria-label="Атремус Second opinion — на главную">
          <BrandMark />
          <span className="so-brand__name">Атремус</span>
          <span className="so-brand__sub">Second opinion</span>
        </a>
        <a className="btn btn-outline" href={cabinetHref ?? CABINET_HREF} target="_blank" rel="noopener">Войти в кабинет</a>
      </div>
    </header>
  );
}

export interface ResultAppProps {
  result: BuildResultT;
  homeHref?: string;
  /** Статический демо-режим: куда ведёт «Проверить» в списке выпусков. */
  hrefFor?: (secid: string) => string | null;
  /** Есть сервер (Э3) — пересборка по цене предложения; нет — показываем пояснение. */
  rebuild?: (inputs: ReportInputs) => Promise<BuildResultT>;
  interactive?: boolean;
}

export function ResultApp(p: ResultAppProps) {
  const [res, setRes] = useState<BuildResultT>(p.result);
  const onInputs = useCallback((i: ReportInputs) => {
    setRes((cur) => (cur.kind === "report" ? { kind: "report", report: applyInputs(cur.report, i) } : cur));
  }, []);
  const onAskPrice = p.rebuild
    ? (price: number) => {
        void p.rebuild!({ offer_price_pct: price }).then(setRes);
      }
    : undefined;
  const home = p.homeHref ?? "./";
  return (
    <div className="so">
      <SiteHeader homeHref={home} />
      {res.kind === "report" ? (
        <ReportView
          report={res.report}
          onInputs={p.interactive === false ? undefined : onInputs}
          onAskPrice={onAskPrice}
          askPriceUnavailableNote="На демо-странице пересчёт по вашей цене недоступен: он делается движком на сервере (этап Э3)."
          newCheckHref={home}
        />
      ) : res.kind === "pick" ? (
        <PickView res={res} hrefFor={p.hrefFor} newCheckHref={home} />
      ) : res.kind === "notfound" ? (
        <NotFoundView res={res} newCheckHref={home} />
      ) : (
        <ErrView res={res} newCheckHref={home} />
      )}
    </div>
  );
}
