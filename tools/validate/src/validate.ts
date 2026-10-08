/**
 * Валидатор страниц Second opinion (dev-док, раздел «Валидатор и golden-набор»).
 * Рендерит каждую собранную страницу в Chromium на 1280 и 390 px и падает, если:
 *   text      — в видимом тексте NaN, undefined, null, Infinity, [object Object], пустые подстановки {…}
 *   console   — ошибки в консоли или исключения страницы
 *   template  — в шаблоне (client.js, css, оболочка HTML) найден факт о бумаге
 *   network   — сетевой ресурс кроме разрешённых шрифтов
 *   schema    — данные страницы не проходят zod-схему контракта
 *   panels / required — блок без выполненного условия, нет обязательного блока или пусто обязательное поле
 *   dom       — отрисованные блоки ≠ panels или на странице не те фразы, что в контракте
 *   control   — расхождение своего расчёта с биржевым > 5 п.п. (> 0,5 — предупреждение)
 *   score     — баллы топ-3, градация и Truth Score не согласованы
 *   aria      — график без aria-label
 *   scroll    — горизонтальный скролл на 390 px вне карточки, которой он положен
 *   legend    — подпись серии, которая ничего не нарисовала
 *   input     — после ввода позиции / комиссии / «обещали» страница ≠ applyInputs движка
 *
 *   tsx src/validate.ts [--dist <dir>]        — проверить сборку (выход 1 при падении)
 *   tsx src/validate.ts --selfcheck           — испортить страницы 11 способами и убедиться, что каждый пойман
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { BuildResult, type BondReportT, type BuildResultT, type ReportInputs } from "@so/engine/contract";
import { applyInputs } from "@so/engine/inputs";
import { checkContract, factTokens, type Finding } from "./rules.js";
import { FontCache } from "./fonts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argDist = process.argv.indexOf("--dist");
const DIST = path.resolve(argDist > 0 ? process.argv[argDist + 1] : path.join(here, "../../../apps/static/dist"));
const fonts = new FontCache(path.join(here, "..", ".cache", "fonts"));
const WIDTHS = [1280, 390] as const;

const norm = (s: string) => s.replace(/[\s  ]+/g, " ").trim();

function readData(html: string): unknown {
  const m = html.match(/<script type="application\/json" id="so-data">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}

/** Оболочка страницы без фактов: вырезаем title, SSR-разметку #root и JSON данных. */
function shellOf(html: string): string {
  return html
    .replace(/<title>[\s\S]*?<\/title>/, "<title></title>")
    .replace(/<script type="application\/json" id="so-data">[\s\S]*?<\/script>/, "")
    .replace(/<div id="root">[\s\S]*<\/div>\s*(?=<script)/, '<div id="root"></div>');
}

function templateFindings(dist: string, pages: string[], tokens: string[]): Finding[] {
  const out: Finding[] = [];
  const sources: [string, string][] = [
    ["assets/client.js", fs.readFileSync(path.join(dist, "assets/client.js"), "utf8")],
    ["assets/blocks.css", fs.readFileSync(path.join(dist, "assets/blocks.css"), "utf8")],
    ...pages.map((p) => [p + " (оболочка)", shellOf(fs.readFileSync(path.join(dist, p), "utf8"))] as [string, string]),
  ];
  for (const [name, text] of sources) {
    for (const t of tokens) if (text.includes(t)) out.push({ rule: "template", level: "fail", msg: `${name}: факт о бумаге «${t}» в шаблоне` });
    const isin = text.match(/\b(RU|SU)[0-9A-Z]{10}\b/);
    if (isin) out.push({ rule: "template", level: "fail", msg: `${name}: ISIN-подобная строка «${isin[0]}»` });
    const date = text.match(/\b\d{2}\.\d{2}\.20\d{2}\b/);
    if (date) out.push({ rule: "template", level: "fail", msg: `${name}: дата «${date[0]}» в шаблоне` });
  }
  return out;
}

interface PageRun { file: string; width: number; findings: Finding[]; screenshot: string }

async function genericChecks(page: Page, width: number): Promise<Finding[]> {
  const out: Finding[] = [];
  const fail = (rule: string, msg: string) => out.push({ rule, msg, level: "fail" });
  const g = await page.evaluate(() => {
    const text = document.body.innerText;
    const charts = [...document.querySelectorAll("[data-chart], svg[role='img'], canvas")]
      .filter((e) => !(e.getAttribute("aria-label") || "").trim())
      .map((e) => e.getAttribute("data-chart") || e.tagName.toLowerCase());
    const legends = [...document.querySelectorAll("[data-legend-for]")]
      .map((e) => e.getAttribute("data-legend-for")!)
      .filter((k) => {
        const s = document.querySelector(`[data-series="${CSS.escape(k)}"]`);
        return !s || s.getBoundingClientRect().width <= 0;
      });
    const vw = document.documentElement.clientWidth;
    const sw = document.documentElement.scrollWidth;
    const wide = [...document.querySelectorAll("body *")]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.right > vw + 1 && !e.closest("[data-scroll-ok]");
      })
      .slice(0, 5)
      .map((e) => `${e.tagName.toLowerCase()}.${(e.getAttribute("class") || "").split(" ")[0]} (${Math.round(e.getBoundingClientRect().right)}px)`);
    return { text, charts, legends, vw, sw, wide };
  });
  const bad = [
    [/\bNaN\b/, "NaN"], [/\bundefined\b/, "undefined"], [/\bnull\b/, "null"], [/Infinity/, "Infinity"],
    [/\[object Object\]/, "[object Object]"], [/\{[^{}\n]{0,40}\}/, "пустая подстановка {…}"],
  ] as const;
  for (const [re, name] of bad) {
    const m = g.text.match(re);
    if (m) fail("text", `в видимом тексте «${name}»: …${g.text.slice(Math.max(0, m.index! - 40), m.index! + 40).replace(/\n/g, " ")}…`);
  }
  for (const c of g.charts) fail("aria", `график без aria-label: ${c}`);
  for (const l of g.legends) fail("legend", `подпись серии «${l}», которая ничего не нарисовала`);
  if (width <= 390 && (g.sw > g.vw + 1 || g.wide.length)) fail("scroll", `горизонтальный скролл на ${width}px: ширина ${g.sw} > ${g.vw}; ${g.wide.join(", ")}`);
  return out;
}

async function reportDomChecks(page: Page, r: BondReportT, prefix = ""): Promise<Finding[]> {
  const out: Finding[] = [];
  const fail = (rule: string, msg: string) => out.push({ rule, msg: prefix + msg, level: "fail" });
  const dom = await page.evaluate(() => {
    const blocks: Record<string, string> = {};
    document.querySelectorAll("#root [data-block]").forEach((e) => {
      const id = e.getAttribute("data-block")!;
      blocks[id] = (blocks[id] ? blocks[id] + " " : "") + (e as HTMLElement).innerText;
    });
    return {
      blocks,
      score: document.querySelector("[data-score]")?.textContent ?? null,
      grade: document.querySelector("[data-grade]")?.textContent ?? null,
      flags: [...document.querySelectorAll("[data-flag]")].map((e) => [Number(e.getAttribute("data-flag")), Number(e.getAttribute("data-points"))]),
    };
  });
  const drawn = Object.keys(dom.blocks).sort();
  const want = [...r.panels].sort();
  if (JSON.stringify(drawn) !== JSON.stringify(want)) fail("dom", `отрисованы блоки [${drawn}] ≠ panels [${want}]`);
  const expect: [string, string | null | undefined][] = [
    ["data_line", r.data_time.line], ["product", r.product.plain_text], ["claim", r.claim.line],
    ["yield", r.yield.kind === "not_calculated" ? r.yield.not_calculated_reason : r.yield.line], ["price_line", r.price.line],
    ["liquidity", r.liquidity.line], ["liquidity", r.liquidity.metrics_line], ["fees", r.fees_tax.line],
    ...r.worst.map((w) => ["worst", w.text] as [string, string]),
  ];
  for (const [id, s] of expect) {
    if (!r.panels.includes(id as never) || !s) continue;
    if (!norm(dom.blocks[id] ?? "").includes(norm(s))) fail("dom", `блок «${id}» не показывает фразу контракта: «${s.slice(0, 80)}…»`);
  }
  if (r.panels.includes("flags_score")) {
    if (dom.score !== String(r.truth_score.score)) fail("dom", `на странице Truth Score ${dom.score}, в контракте ${r.truth_score.score}`);
    if (dom.grade !== r.truth_score.grade) fail("dom", `на странице градация «${dom.grade}», в контракте «${r.truth_score.grade}»`);
    const want3 = r.truth_score.top3.map((id) => [id, r.flags.find((f) => f.id === id)!.points]);
    if (JSON.stringify(dom.flags) !== JSON.stringify(want3)) fail("dom", `топ-3 на странице ${JSON.stringify(dom.flags)} ≠ контракту ${JSON.stringify(want3)}`);
  }
  return out;
}

async function interactionChecks(page: Page, r0: BondReportT): Promise<Finding[]> {
  const out: Finding[] = [];
  if (!(await page.$("[data-inputs]"))) return out;
  let exp = r0;
  const steps: { name: string; act: () => Promise<void>; inp: ReportInputs; enabled: boolean }[] = [
    { name: "позиция 1 млн", act: () => page.click('[data-preset="1000000"]'), inp: { position_size: 1_000_000 }, enabled: true },
    { name: "своя сумма 2 750 000", act: () => page.fill("#in-pos", "2 750 000"), inp: { position_size: 2_750_000 }, enabled: true },
    { name: "комиссия 0,3%", act: () => page.fill("#in-k", "0,3"), inp: { k_pct: 0.3 }, enabled: !!(await page.$("#in-k")) },
    { name: "обещали 30%", act: () => page.fill("#in-pr", "30"), inp: { promised_pct: 30 }, enabled: !!(await page.$("#in-pr")) },
    { name: "обещали — стёрли", act: () => page.fill("#in-pr", ""), inp: { promised_pct: null }, enabled: !!(await page.$("#in-pr")) },
  ];
  for (const s of steps) {
    if (!s.enabled) continue;
    await s.act();
    exp = applyInputs(exp, s.inp);
    await page.waitForTimeout(60);
    out.push(...(await reportDomChecks(page, exp, `после ввода «${s.name}»: `)).map((f) => ({ ...f, rule: "input" })));
    out.push(...(await genericChecks(page, 1280)).map((f) => ({ ...f, msg: `после ввода «${s.name}»: ` + f.msg })));
  }
  return out;
}

async function validatePage(browser: Browser, dist: string, file: string, width: number, interact: boolean): Promise<PageRun> {
  const findings: Finding[] = [];
  const fail = (rule: string, msg: string) => findings.push({ rule, msg, level: "fail" });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  const fontUrls = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (fontUrls.test(m.location().url ?? "")) return; // нет сети для шрифтов — не ошибка страницы
    if (/Failed to load resource/.test(m.text()) && fonts.status === "unavailable") return;
    fail("console", m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => fail("console", "исключение: " + String(e).slice(0, 200)));
  page.on("request", (req) => {
    const u = req.url();
    const ok = u.startsWith("file://" + dist) || u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("about:") || fontUrls.test(u);
    if (!ok) fail("network", `запрос вне разрешённых: ${u.slice(0, 120)}`);
  });
  await fonts.attach(page);
  await page.route(/^https?:\/\/(?!fonts\.(googleapis|gstatic)\.com\/)/, (route) => route.abort()); // в сеть страница не ходит
  await page.goto("file://" + path.join(dist, file));
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(80);

  const html = fs.readFileSync(path.join(dist, file), "utf8");
  const raw = readData(html);
  let res: BuildResultT | null = null;
  if (raw) {
    const parsed = BuildResult.safeParse((raw as { result: unknown }).result);
    if (!parsed.success) fail("schema", "данные страницы не проходят схему: " + parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    else res = parsed.data;
  }
  try {
  findings.push(...(await genericChecks(page, width)));
  if (res?.kind === "report") {
    findings.push(...checkContract(res.report));
    findings.push(...(await reportDomChecks(page, res.report)));
    if (interact) findings.push(...(await interactionChecks(page, res.report)));
    if (interact && res.report.panels.includes("ask_price")) {
      await page.goto("file://" + path.join(dist, file)); // исходное состояние: ввод выше мог пересобрать panels
      await page.fill("#ask-price", "98,5", { timeout: 3000 });
      await page.click("[data-block=ask_price] button[type=submit]");
      await page.waitForTimeout(60);
      if (!(await page.$("[data-block=ask_price] [role=status]"))) fail("input", "форма цены не ответила пользователю");
    }
  } else if (res?.kind === "pick") {
    const n = await page.$$eval("[data-block=pick] [data-secid]", (e) => e.length);
    if (n !== res.candidates.length) fail("dom", `в списке ${n} выпусков, в данных ${res.candidates.length}`);
  } else if (res?.kind === "notfound") {
    const t = await page.textContent("[data-block=notfound]");
    if (!t || !t.includes(res.query)) fail("dom", "экран «Не нашли» не показывает запрос");
  }
  } catch (e) {
    fail("crash", "проверка не завершилась: " + String(e).split("\n")[0].slice(0, 200));
  }
  const shotDir = path.join(dist, "screens");
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = path.join(shotDir, `${path.basename(file, ".html")}-${width}.png`);
  await page.goto("file://" + path.join(dist, file)); // скриншот — исходное состояние, до ввода
  await page.evaluate(() => document.fonts?.ready);
  await page.screenshot({ path: shot, fullPage: true });
  await page.close();
  return { file, width, findings, screenshot: path.relative(dist, shot) };
}

async function validateDist(dist: string, only?: string[]): Promise<{ runs: PageRun[]; template: Finding[] }> {
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8")) as { pages: { file: string }[] };
  const pages = only ?? [...manifest.pages.map((p) => p.file), "showcase.html", "index.html"];
  const allData = manifest.pages
    .map((p) => readData(fs.readFileSync(path.join(dist, p.file), "utf8")) as { result: unknown } | null)
    .filter(Boolean)
    .map((d) => d!.result);
  const template = templateFindings(dist, manifest.pages.map((p) => p.file).filter((f) => !only || only.includes(f)), factTokens(allData));
  const browser = await chromium.launch();
  const runs: PageRun[] = [];
  try {
    for (const file of pages)
      for (const w of WIDTHS) runs.push(await validatePage(browser, dist, file, w, w === 1280 && file.startsWith("pages/")));
  } finally {
    await browser.close();
  }
  return { runs, template };
}

/* ───── основной режим ───── */
async function main() {
  const { runs, template } = await validateDist(DIST);
  const fails = [...template.filter((f) => f.level === "fail"), ...runs.flatMap((r) => r.findings.filter((f) => f.level === "fail"))];
  const warns = runs.flatMap((r) => r.findings.filter((f) => f.level === "warn").map((f) => `${r.file}: ${f.msg}`));
  const byFile = new Map<string, Record<number, number>>();
  for (const r of runs) {
    const m = byFile.get(r.file) ?? {};
    m[r.width] = r.findings.filter((f) => f.level === "fail").length;
    byFile.set(r.file, m);
  }
  console.log(`Шаблон (client.js, css, оболочки): ${template.length ? "ПАДЕНИЕ" : "фактов о бумаге нет"}`);
  for (const f of template) console.log("  ✗ " + f.msg);
  console.log("\nСтраница                         1280   390");
  for (const [file, m] of byFile) console.log(`${file.padEnd(32)} ${m[1280] ? "✗ " + m[1280] : "ok "}   ${m[390] ? "✗ " + m[390] : "ok"}`);
  for (const r of runs) for (const f of r.findings.filter((x) => x.level === "fail")) console.log(`  ✗ [${f.rule}] ${r.file} @${r.width}: ${f.msg}`);
  for (const w of [...new Set(warns)]) console.log(`  ! ${w}`);
  console.log(`\nШрифты: ${fonts.status === "unavailable" ? "недоступны (скриншоты системным шрифтом)" : "Geist из кэша"}`);
  fs.writeFileSync(path.join(DIST, "validation.json"), JSON.stringify({ at: new Date().toISOString(), ok: fails.length === 0, template, runs, warnings: warns }, null, 2));
  console.log(fails.length ? `\nВАЛИДАТОР: ПАДЕНИЕ (${fails.length})` : `\nВАЛИДАТОР OK: ${byFile.size} страниц × ${WIDTHS.length} ширины, ввод проверен на страницах отчётов`);
  process.exit(fails.length ? 1 : 0);
}

/* ───── самопроверка: каждое условие падения должно ловиться ───── */
async function selfcheck() {
  const { renderPage } = await import("../../../apps/static/src/page.js");
  const target = "pages/rolf.html";
  type Mut = { name: string; rule: string; apply: (dir: string) => void };
  const mutateData = (fn: (r: any) => void, rerender = true) => (dir: string) => {
    const f = path.join(dir, target);
    const html = fs.readFileSync(f, "utf8");
    const data = readData(html) as any;
    fn(data.result.report);
    if (rerender) fs.writeFileSync(f, renderPage(data, "../assets/"));
    else fs.writeFileSync(f, html.replace(/(<script type="application\/json" id="so-data">)[\s\S]*?(<\/script>)/, `$1${JSON.stringify(data).replace(/</g, "\\u003c")}$2`));
  };
  const inject = (snippet: string) => (dir: string) => {
    const f = path.join(dir, target);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("</body>", snippet + "\n</body>"));
  };
  const appendCss = (css: string) => (dir: string) => fs.appendFileSync(path.join(dir, "assets/blocks.css"), "\n" + css + "\n");
  const muts: Mut[] = [
    { name: "блок без выполненного условия (ask_price при status=ok)", rule: "panels", apply: mutateData((r) => r.panels.splice(3, 0, "ask_price")) },
    { name: "Truth Score не сходится с баллами", rule: "score", apply: mutateData((r) => { r.truth_score.score = 99; }) },
    { name: "NaN и undefined в тексте", rule: "text", apply: mutateData((r) => { r.yield.line = "NaN% годовых — undefined"; }) },
    { name: "пустая подстановка в тексте", rule: "text", apply: mutateData((r) => { r.price.line = "Цена покупки {price} ₽"; }) },
    { name: "факт о бумаге в шаблоне", rule: "template", apply: appendCss("/* RU000A10ASE2 */") },
    { name: "внешний ресурс", rule: "network", apply: inject('<img src="https://example.com/pixel.png" alt="">') },
    { name: "горизонтальный скролл на 390", rule: "scroll", apply: appendCss(".lead{white-space:nowrap}") },
    { name: "подпись пустой серии", rule: "legend", apply: inject('<div><span data-legend-for="ghost">Серия</span></div>') },
    { name: "график без aria-label", rule: "aria", apply: inject('<div data-chart="ghost"></div>') },
    { name: "расхождение с биржей > 5 п.п.", rule: "control", apply: mutateData((r) => { r.yield.control_diff_pp = 6.2; }) },
    { name: "данные не по схеме", rule: "schema", apply: mutateData((r) => { delete r.yield; }, false) },
    { name: "ошибка в консоли", rule: "console", apply: inject("<script>console.error('boom')</script>") },
  ];
  let missed = 0;
  for (const m of muts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "so-selfcheck-"));
    fs.cpSync(DIST, dir, { recursive: true, filter: (s) => !s.includes(`${path.sep}screens`) });
    m.apply(dir);
    const { runs, template } = await validateDist(dir, [target]);
    const rules = new Set([...template, ...runs.flatMap((r) => r.findings)].filter((f) => f.level === "fail").map((f) => f.rule));
    const caught = rules.has(m.rule);
    if (!caught) missed++;
    console.log(`${caught ? "поймано  " : "ПРОПУЩЕНО"}  [${m.rule}] ${m.name}${caught ? "" : "  — сработали: " + [...rules].join(", ")}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(missed ? `\nSELFCHECK: пропущено ${missed}` : `\nSELFCHECK OK: все ${muts.length} порч пойманы`);
  process.exit(missed ? 1 : 0);
}

if (process.argv.includes("--selfcheck")) await selfcheck();
else await main();
