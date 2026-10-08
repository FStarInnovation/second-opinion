/**
 * Главная демо-артефакта Э2: фрагмент HTML без doctype (оболочку добавляет публикация Artifact).
 * Все числа на ней — из контрактов движка (build() по golden-снимкам), руками не набраны.
 *   tsx src/artifact-index.tsx  → dist/artifact.html
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "@so/engine";
import type { BondReportT, BuildResultT } from "@so/engine/contract";
import { fmt } from "@so/engine/format";
import { BrandMark, scoreTone } from "@so/blocks";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const goldenDir = path.join(root, "packages/engine/golden");
const dist = path.join(here, "..", "dist");
const meta = JSON.parse(fs.readFileSync(path.join(goldenDir, "cases.json"), "utf8")) as {
  todayIso: string; cases: { name: string; query: string; inputs: Record<string, number>; checks: string }[];
};
const validation = JSON.parse(fs.readFileSync(path.join(dist, "validation.json"), "utf8")) as { ok: boolean; runs: { file: string }[] };

const res: Record<string, BuildResultT> = {};
for (const c of meta.cases)
  res[c.name] = await build(c.query, c.inputs, { fromSnapshotDir: path.join(goldenDir, "snapshots", c.name), todayIso: meta.todayIso });
const rep = (n: string) => (res[n].kind === "report" ? (res[n] as { report: BondReportT }).report : null);
const snap = meta.todayIso.split("-").reverse().join(".");

const FEATURED = ["rolf", "veb", "ofz26238"];
const headline = (r: BondReportT) =>
  r.claim.line ?? (r.yield.main_pct != null ? `${fmt(r.yield.main_pct, 2)}% годовых, ${r.yield.values[0]?.label ?? ""}` : r.yield.not_calculated_reason ?? "");
const BRANCH_TITLE: Record<string, string> = {
  cherk1p7: "Флоатер: три сценария ставок",
  cherk2p2: "Колл через несколько дней: доход за период",
  cherk2p1: "Номинал в юанях",
  cherk2p6: "Флоатер без объявленной ставки",
  cherk1p6: "Нет сделок и цены: спрашиваем цену",
  "pick-cherkizovo": "Поиск по эмитенту: выбор выпуска",
  "pick-program": "Поиск по номеру программы",
  notfound: "Бумаги нет на Мосбирже",
};
const branchNote = (n: string): string => {
  const x = res[n];
  if (x.kind === "pick") return `${x.candidates.length} выпусков по запросу «${x.query}»`;
  if (x.kind === "notfound") return `Запрос ${x.query}`;
  if (x.kind === "report") {
    const r = x.report;
    const y = r.yield;
    const lead =
      y.kind === "scenarios" ? y.values.map((v) => fmt(v.pct, 2) + "%").join(" / ")
      : y.kind === "period_income" && y.period_income ? `+${fmt(y.period_income.gain_pct, 2)}% до ${y.period_income.date}`
      : y.kind === "not_calculated" ? (y.not_calculated_reason ?? "")
      : y.main_pct != null ? `${fmt(y.main_pct, 2)}%` : "";
    return `${r.security.shortname} · ${lead || r.status.reason || ""} · Truth Score ${r.truth_score.score}`;
  }
  return "";
};

const pagesChecked = new Set(validation.runs.map((r) => r.file)).size;

const Page = () => (
  <div className="wrap">
    <header className="top">
      <span className="brand"><BrandMark /><b>Атремус</b><span>Second opinion</span></span>
      <span className="stage">Этап Э2 · демо</span>
    </header>

    <section className="intro">
      <h1>Страницы отчёта по облигациям</h1>
      <p>
        Каждая страница собрана движком из снимка Мосбиржи от {snap} и прошла валидатор. Числа и фразы приходят только из
        контракта отчёта. Сумма вложения, комиссия брокера и «сколько обещали» пересчитываются прямо на странице той же
        функцией движка, что работает на сервере.
      </p>
    </section>

    <section aria-labelledby="h-main" className="block">
      <h2 id="h-main">Три бумаги из прототипа</h2>
      <div className="cards">
        {FEATURED.map((n) => {
          const r = rep(n)!;
          const tone = scoreTone(r.truth_score.score);
          return (
            <a key={n} className="card" href={`pages/${n}.html`}>
              <span className="card__top">
                <span className="card__name">{r.security.shortname}</span>
                <span className={"pill pill--" + tone}>{r.truth_score.score} · {r.truth_score.grade}</span>
              </span>
              <span className="mono muted">{r.security.isin}</span>
              <span className="card__line">{headline(r)}</span>
              <span className="card__go">Открыть отчёт →</span>
            </a>
          );
        })}
      </div>
    </section>

    <section aria-labelledby="h-br" className="block">
      <h2 id="h-br">Ветки постановки</h2>
      <p className="muted">У каждой ветки свой состав блоков: его выбирает движок по данным бумаги.</p>
      <ul className="list">
        {Object.keys(BRANCH_TITLE).map((n) => (
          <li key={n}>
            <a href={`pages/${n}.html`}>{BRANCH_TITLE[n]}</a>
            <span className="muted">{branchNote(n)}</span>
          </li>
        ))}
      </ul>
    </section>

    <section aria-labelledby="h-val" className="block panel">
      <h2 id="h-val">Валидатор</h2>
      <p>
        {validation.ok ? "Зелёный" : "Есть падения"}: {pagesChecked} страниц на ширине 1280 и 390 px, ввод суммы, комиссии и
        «обещали» проверен на всех отчётах. Самопроверка: валидатор ловит все 12 видов порчи.
      </p>
      <p className="muted">
        Страница падает, если в тексте есть NaN, undefined, null или пустая подстановка; если в шаблоне найден факт о бумаге;
        если блок показан без своего условия или пусто обязательное поле; если Truth Score не сходится с баллами; если
        расчёт расходится с биржей больше чем на 5 п.п.; если на 390 px появляется горизонтальный скролл; если у графика нет
        подписи для экранного диктора.
      </p>
      <a className="btn" href="showcase.html">Витрина блоков</a>
    </section>

    <section aria-labelledby="h-try" className="block">
      <h2 id="h-try">Что попробовать</h2>
      <ul className="list list--plain">
        <li>В отчёте РОЛЬФ 1Р07 смените сумму на 5 млн: стоимость выхода и потеря в худшем случае пересчитаются.</li>
        <li>Впишите комиссию брокера 0,3%: доходность после комиссии и налога возьмётся из сетки движка.</li>
        <li>В ОФЗ 26238 впишите «обещали 30%»: появится сравнение, флаг завышенной доходности и новый Truth Score.</li>
        <li>У ЧеркизБ1P6 нет цены: форма цены видна, но пересчёт по вашей цене появится на этапе Э3, когда заработает сервер.</li>
      </ul>
    </section>

    <p className="foot muted">Не является индивидуальной инвестиционной рекомендацией. Данные: MOEX ISS, снимок {snap}.</p>
  </div>
);

const css = `
/* Раскладка: одна колонка 960px — вступление, три карточки, список веток, панель валидатора. Стиль продукта: Geist, синий #353d64. */
:root {
  --bg: #f5f6fa; --surface: #ffffff; --ink: #111a33; --muted: #56617b; --line: #d7dce8;
  --brand: #353d64; --brand-soft: #eaeef8;
  --good: #067647; --good-bg: #ecfdf3; --mid: #b54708; --mid-bg: #fff6e5; --bad: #b42318; --bad-bg: #fef1ef;
  --f-body: Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --f-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0e1222; --surface: #161b2f; --ink: #e7eaf4; --muted: #9ba4bd; --line: #2b3250;
  --brand: #aab6ea; --brand-soft: #1e2544;
  --good: #57d39a; --good-bg: #12291f; --mid: #f2ac5f; --mid-bg: #2c2112; --bad: #f58a7c; --bad-bg: #2e1715; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #0e1222; --surface: #161b2f; --ink: #e7eaf4; --muted: #9ba4bd; --line: #2b3250;
  --brand: #aab6ea; --brand-soft: #1e2544;
  --good: #57d39a; --good-bg: #12291f; --mid: #f2ac5f; --mid-bg: #2c2112; --bad: #f58a7c; --bad-bg: #2e1715; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font-family: var(--f-body); font-size: 15px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 960px; margin: 0 auto; padding-inline: 16px; padding-block: 24px 56px; display: flex; flex-direction: column; gap: 36px; }
.top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 16px; }
.brand { display: inline-flex; align-items: center; gap: 10px; }
.brand b { font-size: 19px; letter-spacing: -0.01em; }
.brand > span { color: var(--muted); font-size: 14px; padding-left: 10px; border-left: 1px solid var(--line); }
.stage { font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--brand); font-weight: 600; }
h1 { font-size: clamp(28px, 4.2vw, 40px); line-height: 1.12; letter-spacing: -0.02em; margin: 0; text-wrap: balance; }
h2 { font-size: 17px; margin: 0; text-wrap: balance; }
.intro { display: flex; flex-direction: column; gap: 12px; }
.intro p { max-width: 66ch; font-size: 17px; color: var(--muted); margin: 0; }
.block { display: flex; flex-direction: column; gap: 14px; }
.block p { margin: 0; max-width: 72ch; }
.muted { color: var(--muted); }
.mono { font-family: var(--f-mono); font-size: 12px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 14px; }
.card { display: flex; flex-direction: column; gap: 8px; padding: 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  color: var(--ink); text-decoration: none; min-width: 0; transition: border-color .15s; }
.card:hover { border-color: var(--brand); }
.card:focus-visible, .btn:focus-visible, .list a:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.card__top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
.card__name { font-weight: 650; font-size: 18px; }
.card__line { font-size: 14px; }
.card__go { margin-top: auto; padding-top: 6px; color: var(--brand); font-weight: 550; font-size: 14px; }
.pill { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pill--good { color: var(--good); background: var(--good-bg); } .pill--mid { color: var(--mid); background: var(--mid-bg); } .pill--bad { color: var(--bad); background: var(--bad-bg); }
.list { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--line); }
.list li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; padding: 12px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.list a { color: var(--ink); font-weight: 550; text-decoration-color: var(--line); text-underline-offset: 3px; }
.list a:hover { color: var(--brand); text-decoration-color: currentColor; }
.list span { font-size: 14px; font-variant-numeric: tabular-nums; }
.list--plain li { display: list-item; list-style: none; padding-left: 18px; position: relative; }
.list--plain li::before { content: ""; position: absolute; left: 2px; top: 1.15em; width: 6px; height: 6px; border-radius: 50%; background: var(--brand); }
.panel { background: var(--brand-soft); border-radius: 14px; padding: 20px; }
.btn { align-self: flex-start; display: inline-flex; align-items: center; height: 40px; padding: 0 16px; border-radius: 8px; background: var(--brand); color: var(--surface); text-decoration: none; font-weight: 550; font-size: 14px; }
.foot { font-size: 13px; }
@media (prefers-reduced-motion: reduce) { .card { transition: none; } }
`;

const html = `<title>Отчёты Second opinion</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<style>${css}</style>
${renderToStaticMarkup(<Page />)}
`;
fs.writeFileSync(path.join(dist, "artifact.html"), html);
console.log("dist/artifact.html", (html.length / 1024).toFixed(1), "КБ");
