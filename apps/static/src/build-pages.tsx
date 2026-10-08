/**
 * SSG Э2: golden-снимки ISS → build() движка → статические страницы отчёта + витрина блоков.
 *   tsx src/build-pages.tsx [--out dist]
 * Выход:
 *   dist/pages/<case>.html   — страница каждого golden-кейса (SSR + гидратация для ввода позиции / комиссии / «обещали»)
 *   dist/showcase.html       — витрина блоков реестра во всех вариациях, встреченных в golden
 *   dist/index.html          — список страниц
 *   dist/assets/client.js, blocks.css — шаблон без фактов (проверяет валидатор)
 *   dist/manifest.json       — манифест сборки: дата снимка, кейсы, панели, хэши ассетов
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "@so/engine";
import type { BondReportT, BuildResultT, PanelIdT } from "@so/engine/contract";
import { BLOCKS, SiteHeader } from "@so/blocks";
import { renderPage, FONT_HREF, type PageData } from "./page.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const goldenDir = path.join(root, "packages/engine/golden");
const outArg = process.argv.indexOf("--out");
const dist = path.resolve(outArg > 0 ? process.argv[outArg + 1] : path.join(here, "..", "dist"));

interface Case { name: string; query: string; inputs: Record<string, number>; checks: string }
const meta = JSON.parse(fs.readFileSync(path.join(goldenDir, "cases.json"), "utf8")) as { todayIso: string; cases: Case[] };

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "pages"), { recursive: true });
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });

/* 1. Шаблон: клиентский бандл + стили */
await esbuild({
  entryPoints: [path.join(here, "client.tsx")],
  bundle: true, minify: true, format: "iife", target: "es2020", platform: "browser",
  jsx: "automatic", legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: path.join(dist, "assets/client.js"),
  logLevel: "warning",
});
fs.copyFileSync(path.join(root, "packages/blocks/src/styles.css"), path.join(dist, "assets/blocks.css"));

/* 2. Контракты из замороженных снимков — тем же build(), что и везде (инвариант 1) */
const results: { c: Case; res: BuildResultT }[] = [];
for (const c of meta.cases) {
  const res = await build(c.query, c.inputs, {
    fromSnapshotDir: path.join(goldenDir, "snapshots", c.name),
    todayIso: meta.todayIso,
  });
  results.push({ c, res });
}
const links: Record<string, string> = {};
for (const { c, res } of results) if (res.kind === "report") links[res.report.security.secid] = `${c.name}.html`;

/* 3. Страницы */
for (const { c, res } of results) {
  const data: PageData = { result: res, home: "../index.html", links };
  fs.writeFileSync(path.join(dist, "pages", `${c.name}.html`), renderPage(data, "../assets/"));
}

/* 4. Витрина блоков: каждый блок реестра во всех вариациях из golden */
const variantOf = (id: PanelIdT, r: BondReportT): string =>
  id === "yield" ? r.yield.kind
  : id === "liquidity" ? (r.liquidity.no_exit ? "no_exit" : r.liquidity.category)
  : id === "flags_score" ? (r.truth_score.none_fired ? "none_fired" : `${r.truth_score.top3.length} flags`)
  : id === "fees" ? (r.fees_tax.k_pct ? "k" : "no k")
  : id === "worst" ? `${r.worst.length} risks`
  : r.status.kind;
const shown = new Map<string, { id: PanelIdT; variant: string; c: Case; r: BondReportT }>();
for (const { c, res } of results) {
  if (res.kind !== "report") continue;
  for (const id of res.report.panels) {
    const key = `${id}|${variantOf(id, res.report)}`;
    if (!shown.has(key)) shown.set(key, { id, variant: variantOf(id, res.report), c, r: res.report });
  }
}
const order = Object.keys(BLOCKS) as PanelIdT[];
const items = [...shown.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const showcase = renderToStaticMarkup(
  <div className="so">
    <SiteHeader homeHref="index.html" />
    <div className="so-main">
      <div className="so-title">
        <span className="so-title__kind">Витрина блоков · Э2</span>
        <h1>Реестр блоков отчёта</h1>
        <p className="text">Каждый блок реестра во всех вариациях, встреченных в golden-наборе. Данные — из контрактов bond_report@1.</p>
      </div>
      {items.map(({ id, variant, c, r }) => {
        const B = BLOCKS[id];
        return (
          <section key={id + variant} className="stack" style={{ gap: 8 }} data-showcase={id}>
            <p className="cap mono">{id} · {variant} · <a href={`pages/${c.name}.html`}>{c.name}</a></p>
            <div className="card" style={{ background: "#fbfcfe" }}><B r={r} /></div>
          </section>
        );
      })}
    </div>
  </div>,
);
const shell = (title: string, body: string) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="${FONT_HREF}"><link rel="stylesheet" href="assets/blocks.css"></head>
<body>${body}</body></html>
`;
fs.writeFileSync(path.join(dist, "showcase.html"), shell("Витрина блоков · Second opinion", showcase));

/* 5. Список страниц */
const describe = (res: BuildResultT) =>
  res.kind === "report"
    ? `${res.report.security.shortname} · ${res.report.status.kind} · ${res.report.yield.kind} · Truth Score ${res.report.truth_score.score}`
    : res.kind;
const index = renderToStaticMarkup(
  <div className="so">
    <SiteHeader homeHref="index.html" />
    <div className="so-main so-main--narrow">
      <div className="so-title">
        <span className="so-title__kind">Э2 · статические страницы из golden-набора</span>
        <h1 className="so-h1">Second opinion: отчёты по облигациям</h1>
        <p className="text">Снимки MOEX ISS от {meta.todayIso.split("-").reverse().join(".")}. Каждая страница собрана движком из замороженного снимка и прошла валидатор.</p>
      </div>
      <section className="card" style={{ gap: 0, padding: "8px 24px" }}>
        {results.map(({ c, res }) => (
          <a key={c.name} href={`pages/${c.name}.html`} className="pick__row" style={{ textDecoration: "none", color: "inherit", gridTemplateColumns: "1fr", gridTemplateAreas: "none" }}>
            <span style={{ fontWeight: 600 }}>{describe(res)}</span>
            <span className="cap">{c.checks}</span>
          </a>
        ))}
      </section>
      <a className="btn btn-outline btn-lg" href="showcase.html">Витрина блоков</a>
    </div>
  </div>,
);
fs.writeFileSync(path.join(dist, "index.html"), shell("Second opinion · Э2", index));

/* 6. Манифест сборки (паттерн README/манифеста uw-dashboard) */
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16);
const manifest = {
  built_at: new Date().toISOString(),
  snapshot_date: meta.todayIso,
  schema: "bond_report@1",
  template: { "assets/client.js": sha(path.join(dist, "assets/client.js")), "assets/blocks.css": sha(path.join(dist, "assets/blocks.css")) },
  pages: results.map(({ c, res }) => ({
    case: c.name, file: `pages/${c.name}.html`, query: c.query, inputs: c.inputs, kind: res.kind,
    panels: res.kind === "report" ? res.report.panels : null,
  })),
  rebuild: "npm run pages (из корня репозитория)",
};
fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const kb = (f: string) => (fs.statSync(path.join(dist, f)).size / 1024).toFixed(0) + " КБ";
console.log(`Собрано: ${results.length} страниц, витрина (${items.length} вариаций блоков), client.js ${kb("assets/client.js")} → ${path.relative(process.cwd(), dist) || dist}`);
