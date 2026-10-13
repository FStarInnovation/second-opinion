"use client";
/**
 * Граница ошибок страницы /check: любой непойманный сбой при сборке отчёта — понятный текст и путь дальше вместо голого 500.
 * Сбой Мосбиржи сюда обычно не доходит: buildCached отдаёт его конвертом {kind:"err"} (lib/engine.ts) и страница рисует ErrView.
 */
import { SiteHeader } from "@so/blocks";

export default function CheckError() {
  return (
    <div className="so">
      <SiteHeader homeHref="/" />
      <div className="so-main so-main--tiny" data-branch="err">
        <section className="card so-404" data-block="err" aria-labelledby="h-check-error">
          <h1 id="h-check-error" style={{ fontSize: 24, fontWeight: 700 }}>Не получилось собрать отчёт</h1>
          <p className="text">
            Что-то пошло не так: Мосбиржа не ответила или у нас сбой. Попробуйте ещё раз через минуту.
          </p>
          <div className="row-btns">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => window.location.reload()}>Попробовать ещё раз</button>
            <a className="btn btn-outline btn-lg" href="/">На главную</a>
          </div>
        </section>
      </div>
    </div>
  );
}
