/**
 * WP-SEO (apps/web): SEO-фундамент сайта — sitemap, robots, метаданные, картинки, schema.org, llms.txt, Метрика.
 * Каждая проверка утверждает ЖЕЛАЕМОЕ поведение: RED — дефект есть сейчас, GREEN — поведение уже правильное.
 *
 *  SEO.1  unit    sitemap(): ровно один адрес — главная `${SITE}/` (https, основной домен); /check и /chat — инструменты.
 *  SEO.2  unit    robots() по умолчанию закрыт (SO_PUBLIC не задан или 0): «User-agent: * / Disallow: /», без sitemap — guard.
 *  SEO.3  unit    robots() при SO_PUBLIC=1: allow «/», disallow «/api/», sitemap `${SITE}/sitemap.xml`, host SITE.
 *  SEO.4  unit    layout.tsx: metadataBase = SITE, Open Graph (website, ru_RU, siteName, title, description), twitter summary_large_image.
 *  SEO.5  unit    свой canonical у каждой страницы: «/» (и og:url «/»), «/check» (generateMetadata), «/chat».
 *  SEO.6  static  картинки по соглашению файлов Next: app/opengraph-image.png 1200×630, app/icon.svg, app/apple-icon.png 180×180.
 *  SEO.7  unit    JSON-LD только на «/»: WebSite + WebApplication (FinanceApplication, ru, бесплатно, 0 RUB) + FAQPage, и FAQPage —
 *                 из того же FAQ, что отрисован: вопросы ≡ <summary>, ответы ≡ текст .faq__a (рендер Home() через react-dom/server,
 *                 с чатом и без — SO_CHAT=0 убирает пункт и со страницы, и из JSON-LD); адреса — основной домен.
 *  SEO.8  unit    GET /llms.txt (route.ts как функция): 200 text/plain; utf-8, ссылки только на основной домен, есть «/», /check,
 *                 /chat (без чата — нет), все вопросы FAQ и пункты «Что покажем» — из тех же текстов, что на странице.
 *  SEO.9  unit    Метрика выключена по умолчанию: layout без NEXT_PUBLIC_YM_ID не рендерит <Metrika>, с номером — рендерит;
 *                 metrika.tsx — клиентский, init с clickmap/trackLinks/accurateTrackBounce/webvisor и defer, хит на навигацию
 *                 (usePathname/useSearchParams в Suspense, без m), reachGoal без счётчика — ничего не делает.
 *  SEO.10 static  Вебвизор не записывает ввод: ym-hide-content ym-disable-keys у полей главной (q, promised, m), поля чата
 *                 (ComposerPrimitive.Input) и полей отчёта (@so/blocks: ask-price, in-pos, in-k, in-pr); цели data-goal:
 *                 check_submit (форма /check), chat_open (форма /chat, примеры вопросов, «Обсудить с ассистентом»), login_click
 *                 («Войти в кабинет»), и слушатель [data-goal] в metrika.tsx.
 *  SEO.11 live    прод (или AUDIT_SEO_BASE): на «/» canonical — основной домен и путь «/».
 *  SEO.12 live    og:image главной — абсолютный адрес основного домена, отдаётся картинкой.
 *  SEO.13 live    /llms.txt — 200, text/plain, ссылки на основной домен.
 *
 * Модули app/* грузятся как есть: CSS-импорты layout.tsx и "server-only" (lib/engine.ts) — resolve-хук → пустой модуль.
 * Второй экземпляр layout.tsx (с NEXT_PUBLIC_YM_ID) — импорт с ?ym=1: номер счётчика читается при загрузке модуля, как при сборке.
 * React-рендер: packages/blocks tsx транслирует классическим JSX — перед рендером globalThis.React = React (как в wp-u-ui.ts).
 * Сеть: только live-проверки, GET к SITE (или AUDIT_SEO_BASE — тогда адреса основного домена переписываются на него).
 */
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import type { ReactElement, ReactNode } from "react";
import { type Check, type Verdict, pass, fail, readSrc, WEB_ROOT, REPO_ROOT } from "../lib";

type SiteMod = typeof import("../../lib/site");
type LayoutMod = typeof import("../../app/layout");
type HomeMod = typeof import("../../app/page");
type ContentMod = typeof import("../../app/home-content");

const show = (v: unknown) => JSON.stringify(v);
const cut = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
/** Текст для сравнения без учёта пробелов и маркеров списка «- » (nodeText ставит их у пунктов) */
const squash = (s: string) => s.split("\n").map((l) => l.replace(/^- /, "")).join(" ").replace(/\s+/g, "");
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return ""; } };

/* ───── окружение: временно переопределить env и вернуть обратно ───── */
async function withEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

/* ───── загрузка app/*: CSS и "server-only" → пустой модуль ───── */
let hooked = false;
function ensureHook() {
  if (hooked) return;
  const hook = `export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
  if (/\\.css$/.test(specifier)) return { url: "data:text/javascript,export default {}", shortCircuit: true };
  return next(specifier, context);
}`;
  register("data:text/javascript," + encodeURIComponent(hook));
  hooked = true;
}
/** SITE берётся из окружения при загрузке lib/site.ts — без SITE_URL разработчика, как на проде */
const BASE_ENV = { SITE_URL: undefined, NEXT_PUBLIC_YM_ID: undefined, SO_PUBLIC: undefined, SO_CHAT: undefined };
let siteMod: SiteMod | null = null;
async function site(): Promise<SiteMod> {
  ensureHook();
  siteMod ??= await withEnv(BASE_ENV, () => import("../../lib/site"));
  return siteMod;
}
const appFile = (rel: string) => path.join(WEB_ROOT, "app", rel);
const fileUrl = (rel: string, query = "") => pathToFileURL(appFile(rel)).href + query;

/* ───── React: обход дерева элементов и рендер ───── */
function findAll(node: unknown, pred: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out; }
  if (node && typeof node === "object" && "props" in node && "type" in node) {
    const el = node as ReactElement<Record<string, unknown>>;
    if (pred(el)) out.push(el);
    findAll(el.props?.children, pred, out);
  }
  return out;
}
async function renderHtml(el: () => ReactNode): Promise<string> {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const g = globalThis as unknown as { React?: unknown };
  g.React ??= React; // packages/blocks транслируется классическим JSX — см. шапку
  return renderToStaticMarkup(el() as ReactElement);
}
/** Главная как HTML: Home() при заданном SO_CHAT (модуль один — флаг читается при каждом вызове) */
async function renderHome(chat: "1" | "0"): Promise<string> {
  await site();
  const home = (await import("../../app/page")) as HomeMod;
  return withEnv({ ...BASE_ENV, SO_CHAT: chat }, async () => {
    const React = await import("react");
    return renderHtml(() => React.createElement(home.default));
  });
}

/* ═══════════════ проверки ═══════════════ */

const SEO1: Check = {
  id: "SEO.1", wp: "SEO", kind: "unit",
  title: "sitemap.xml: только главная `${SITE}/` на основном домене (https); /check и /chat — инструменты, в sitemap их нет",
  async run(): Promise<Verdict> {
    const { SITE } = await site();
    const rel = "apps/web/app/sitemap.ts";
    if (!fs.existsSync(path.join(REPO_ROOT, rel))) return fail(`нет ${rel} | ожид.: app/sitemap.ts с одним адресом ${SITE}/`);
    const mod = (await import("../../app/sitemap")) as { default: () => Array<{ url: string }> };
    const items = mod.default();
    const urls = items.map((x) => x.url);
    const ok = urls.length === 1 && urls[0] === `${SITE}/` && urls[0].startsWith("https://");
    const detail = `${rel}: ${urls.length} адрес(ов) ${show(urls)}; SITE=${SITE} | ожид.: ровно [${SITE}/]`;
    return ok ? pass(detail) : fail(detail);
  },
};

type RobotsRule = { userAgent?: string | string[]; allow?: string | string[]; disallow?: string | string[] };
type Robots = { rules: RobotsRule | RobotsRule[]; sitemap?: string | string[]; host?: string };
const arr = <T,>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
async function robotsWith(env: string | undefined): Promise<Robots> {
  await site();
  const mod = (await import("../../app/robots")) as { default: () => Robots };
  return withEnv({ SO_PUBLIC: env }, () => mod.default());
}
const fmtRobots = (r: Robots) =>
  arr(r.rules).map((x) => `UA ${arr(x.userAgent).join(",")} allow ${show(arr(x.allow))} disallow ${show(arr(x.disallow))}`).join("; ") +
  `; sitemap ${show(arr(r.sitemap))}; host ${show(r.host ?? null)}`;

const SEO2: Check = {
  id: "SEO.2", wp: "SEO", kind: "unit", guard: true,
  title: "robots.txt стенда закрыт по умолчанию: без SO_PUBLIC и при SO_PUBLIC=0 — «User-agent: * / Disallow: /», без Sitemap",
  async run(): Promise<Verdict> {
    const rows: string[] = [];
    let ok = true;
    for (const env of [undefined, "0"]) {
      const r = await robotsWith(env);
      const rules = arr(r.rules);
      const star = rules.find((x) => arr(x.userAgent).includes("*"));
      const closed = !!star && arr(star.disallow).includes("/") && arr(star.allow).length === 0 && arr(r.sitemap).length === 0;
      ok &&= closed;
      rows.push(`SO_PUBLIC=${env ?? "не задан"}: ${fmtRobots(r)} → ${closed ? "закрыт" : "ОТКРЫТ"}`);
    }
    const detail = `${rows.join(" | ")} | ожид.: стенд не индексируется, пока не задан SO_PUBLIC=1`;
    return ok ? pass(detail) : fail(detail);
  },
};

const SEO3: Check = {
  id: "SEO.3", wp: "SEO", kind: "unit",
  title: "robots.txt при SO_PUBLIC=1: allow «/», disallow «/api/», Sitemap `${SITE}/sitemap.xml`, Host — основной домен",
  async run(): Promise<Verdict> {
    const { SITE } = await site();
    const r = await robotsWith("1");
    const star = arr(r.rules).find((x) => arr(x.userAgent).includes("*"));
    const allowRoot = !!star && arr(star.allow).includes("/") && !arr(star.disallow).includes("/");
    const apiClosed = !!star && arr(star.disallow).includes("/api/");
    const sm = arr(r.sitemap);
    const smOk = sm.length === 1 && sm[0] === `${SITE}/sitemap.xml`;
    const hostOk = r.host === SITE || r.host === hostOf(SITE);
    const detail = `SO_PUBLIC=1: ${fmtRobots(r)}; allow «/» ${allowRoot}, /api/ закрыт ${apiClosed}, sitemap ${smOk}, host ${hostOk} | ` +
      `ожид.: allow «/», disallow «/api/», sitemap ${SITE}/sitemap.xml, host ${SITE}`;
    return allowRoot && apiClosed && smOk && hostOk ? pass(detail) : fail(detail);
  },
};

const SEO4: Check = {
  id: "SEO.4", wp: "SEO", kind: "unit",
  title: "layout.tsx: metadataBase — основной домен, Open Graph по умолчанию (website, ru_RU, siteName, title, description), Twitter summary_large_image",
  async run(): Promise<Verdict> {
    const { SITE, SITE_NAME, SITE_DESCRIPTION } = await site();
    const layout = (await withEnv(BASE_ENV, () => import("../../app/layout"))) as LayoutMod;
    const m = layout.metadata as Record<string, unknown> & {
      metadataBase?: URL | null; openGraph?: Record<string, unknown>; twitter?: Record<string, unknown>;
    };
    const base = m.metadataBase instanceof URL ? m.metadataBase.href : String(m.metadataBase ?? "");
    const og = m.openGraph ?? {};
    const tw = m.twitter ?? {};
    const checks: [string, boolean][] = [
      [`metadataBase=${base}`, base === `${SITE}/`],
      [`og:type=${show(og.type)}`, og.type === "website"],
      [`og:locale=${show(og.locale)}`, og.locale === "ru_RU"],
      [`og:site_name=${show(og.siteName)}`, og.siteName === SITE_NAME],
      [`og:title=${show(og.title)}`, og.title === SITE_NAME],
      [`og:description ${og.description === SITE_DESCRIPTION ? "= описание сайта" : show(og.description)}`, og.description === SITE_DESCRIPTION],
      [`twitter:card=${show(tw.card)}`, tw.card === "summary_large_image"],
      [`title ${m.title === SITE_NAME ? "= SITE_NAME" : show(m.title)}`, m.title === SITE_NAME],
      [`description ${m.description === SITE_DESCRIPTION ? "= SITE_DESCRIPTION" : show(m.description)}`, m.description === SITE_DESCRIPTION],
    ];
    const bad = checks.filter(([, v]) => !v).map(([k]) => k);
    const detail = `${checks.map(([k, v]) => `${k}${v ? "" : " ✗"}`).join("; ")} | ожид.: всё из lib/site.ts (SITE=${SITE})`;
    return bad.length ? fail(detail) : pass(detail);
  },
};

const SEO5: Check = {
  id: "SEO.5", wp: "SEO", kind: "unit",
  title: "Свой canonical у каждой страницы: «/» (и og:url «/»), «/check» (generateMetadata, без параметров), «/chat»",
  async run(): Promise<Verdict> {
    await site();
    ensureHook();
    type Meta = { alternates?: { canonical?: unknown }; openGraph?: { url?: unknown } };
    const home = (await import("../../app/page")) as unknown as { metadata?: Meta };
    const chat = (await withEnv({ SO_USAGE_LOG: "0", SO_QUIET: "1" }, () => import("../../app/chat/page"))) as unknown as { metadata?: Meta };
    const check = (await withEnv({ SO_USAGE_LOG: "0", SO_QUIET: "1" }, () => import("../../app/check/page"))) as unknown as {
      metadata?: Meta; generateMetadata?: (p: { searchParams: Promise<Record<string, string>> }) => Promise<Meta>;
    };
    const checkMeta = check.generateMetadata
      ? await check.generateMetadata({ searchParams: Promise.resolve({ q: "RU000A1038V6", promised: "15" }) })
      : check.metadata;
    const rows: [string, unknown, string][] = [
      ["/ canonical", home.metadata?.alternates?.canonical, "/"],
      ["/ og:url", home.metadata?.openGraph?.url, "/"],
      ["/check?q=RU000A1038V6&promised=15 canonical", checkMeta?.alternates?.canonical, "/check"],
      ["/chat canonical", chat.metadata?.alternates?.canonical, "/chat"],
    ];
    const bad = rows.filter(([, got, want]) => String(got) !== want);
    const detail = rows.map(([k, got, want]) => `${k}=${show(got ?? null)}${String(got) === want ? "" : ` ✗ (ожид. ${want})`}`).join("; ") +
      " | абсолютный адрес — metadataBase (SEO.4)";
    return bad.length ? fail(detail) : pass(detail);
  },
};

/** Размер PNG из заголовка IHDR */
function pngSize(file: string): { w: number; h: number } | null {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.toString("latin1", 1, 4) !== "PNG" || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const SEO6: Check = {
  id: "SEO.6", wp: "SEO", kind: "static",
  title: "Картинки по соглашению файлов Next: app/opengraph-image.png 1200×630, app/icon.svg, app/apple-icon.png 180×180, app/favicon.ico",
  run(): Verdict {
    const rows: string[] = [];
    let ok = true;
    for (const [f, w, h] of [["opengraph-image.png", 1200, 630], ["apple-icon.png", 180, 180]] as const) {
      const p = appFile(f);
      const s = fs.existsSync(p) ? pngSize(p) : null;
      const good = s != null && s.w === w && s.h === h;
      ok &&= good;
      rows.push(`${f}: ${s ? `${s.w}×${s.h}` : fs.existsSync(p) ? "не PNG" : "нет"}${good ? "" : ` ✗ (ожид. ${w}×${h})`}`);
    }
    const svg = appFile("icon.svg");
    const svgSrc = fs.existsSync(svg) ? fs.readFileSync(svg, "utf8") : "";
    const svgOk = /<svg\b[^>]*\bviewBox="[^"]+"/.test(svgSrc);
    ok &&= svgOk;
    rows.push(`icon.svg: ${svgSrc ? (svgOk ? "<svg viewBox>" : "без <svg viewBox> ✗") : "нет ✗"}`);
    // /favicon.ico запрашивают браузеры и роботы напрямую, без <link rel=icon>: без файла — 404 в журнале
    const ico = appFile("favicon.ico");
    const icoHead = fs.existsSync(ico) ? fs.readFileSync(ico).subarray(0, 4) : null;
    const icoOk = icoHead != null && icoHead[0] === 0 && icoHead[1] === 0 && icoHead[2] === 1 && icoHead[3] === 0;
    ok &&= icoOk;
    rows.push(`favicon.ico: ${icoHead ? (icoOk ? "ICO" : "не ICO ✗") : "нет ✗"}`);
    const alt = appFile("opengraph-image.alt.txt");
    rows.push(`справочно, opengraph-image.alt.txt: ${fs.existsSync(alt) ? `«${cut(oneLine(fs.readFileSync(alt, "utf8")), 70)}»` : "нет"}`);
    const detail = `${rows.join("; ")} | заглушки до макета дизайнера; ожид.: файлы есть, размеры как в соглашении`;
    return ok ? pass(detail) : fail(detail);
  },
};

type Graph = Record<string, unknown> & { "@type"?: string | string[] };
const typesOf = (g: Graph[]) => g.flatMap((x) => arr(x["@type"]));
/** Все строки-адреса (url, @id, image, item, logo, contentUrl) в JSON-LD */
function ldUrls(o: unknown, out: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((v) => ldUrls(v, out));
  else if (o && typeof o === "object")
    for (const [k, v] of Object.entries(o)) {
      if (["url", "@id", "image", "item", "logo", "contentUrl"].includes(k) && typeof v === "string" && /^https?:/.test(v)) out.push(v);
      ldUrls(v, out);
    }
  return out;
}
/** Из HTML главной: JSON-LD и FAQ как отрисован (<summary> и .faq__a) */
function parseHome(html: string) {
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const faq = [...html.matchAll(/<details><summary>([\s\S]*?)<\/summary><div class="faq__a">([\s\S]*?)<\/div><\/details>/g)]
    .map((m) => ({ q: oneLine(unescapeHtml(m[1].replace(/<[^>]+>/g, " "))), a: oneLine(unescapeHtml(m[2].replace(/<[^>]+>/g, " "))) }));
  return { ld, faq };
}

const SEO7: Check = {
  id: "SEO.7", wp: "SEO", kind: "unit",
  title: "JSON-LD только на «/»: WebSite + WebApplication (FinanceApplication, ru, бесплатно, 0 RUB) + FAQPage из отрисованного FAQ (вопросы и ответы ≡ странице, с чатом и без)",
  async run(): Promise<Verdict> {
    const { SITE } = await site();
    const rows: string[] = [];
    let ok = true;
    for (const chat of ["1", "0"] as const) {
      const html = await renderHome(chat);
      const { ld, faq } = parseHome(html);
      if (ld.length !== 1) { ok = false; rows.push(`SO_CHAT=${chat}: скриптов ld+json ${ld.length} ✗ (ожид. 1)`); continue; }
      const data = JSON.parse(ld[0]) as { "@context"?: string; "@graph"?: Graph[] };
      const graph = data["@graph"] ?? [data as Graph];
      const types = typesOf(graph);
      const app = graph.find((g) => arr(g["@type"]).includes("WebApplication")) as Graph & { offers?: Record<string, unknown> } | undefined;
      const fp = graph.find((g) => arr(g["@type"]).includes("FAQPage")) as Graph & { mainEntity?: Array<{ name?: string; acceptedAnswer?: { text?: string } }> } | undefined;
      const appOk = !!app && app.applicationCategory === "FinanceApplication" && app.inLanguage === "ru" && app.isAccessibleForFree === true &&
        String(app.offers?.price) === "0" && app.offers?.priceCurrency === "RUB";
      const qs = (fp?.mainEntity ?? []).map((x) => ({ q: x.name ?? "", a: x.acceptedAnswer?.text ?? "" }));
      const sameQ = qs.length === faq.length && qs.every((x, i) => x.q === faq[i].q);
      const diffA = qs.map((x, i) => (faq[i] && squash(x.a) === squash(faq[i].a) ? null : x.q)).filter((x): x is string => x != null);
      const foreign = ldUrls(data).filter((u) => hostOf(u) !== hostOf(SITE) || !u.startsWith("https://"));
      const good = types.includes("WebSite") && types.includes("WebApplication") && types.includes("FAQPage") && appOk &&
        faq.length > 0 && sameQ && diffA.length === 0 && foreign.length === 0 && data["@context"] === "https://schema.org";
      ok &&= good;
      rows.push(`SO_CHAT=${chat}: типы ${show(types)}; WebApplication ${appOk ? "ок" : `✗ ${cut(show(app ?? null), 160)}`}; ` +
        `FAQ на странице ${faq.length}, в FAQPage ${qs.length}, вопросы ${sameQ ? "совпадают" : `✗ ${cut(show(qs.map((x) => x.q)), 120)}`}, ` +
        `ответы ${diffA.length ? `✗ расходятся: ${show(diffA)}` : "совпадают"}; чужие адреса ${foreign.length ? show(foreign) : "нет"}`);
    }
    // Только на главной: разметка ld+json — в одном компоненте, и он подключён только в app/page.tsx
    const files = ["app/layout.tsx", "app/chat/page.tsx", "app/check/page.tsx", "app/check/CheckClient.tsx", "components/ChatApp.tsx", "components/Thread.tsx"];
    const leaks = files.filter((f) => /application\/ld\+json|HomeJsonLd/.test(readSrc(`apps/web/${f}`)));
    const onHome = /<HomeJsonLd\s+faq=\{items\}/.test(readSrc("apps/web/app/page.tsx")) && /items\.map\(/.test(readSrc("apps/web/app/page.tsx"));
    ok &&= leaks.length === 0 && onHome;
    const detail = `${rows.join(" | ")} | page.tsx: <HomeJsonLd faq={items}> и FAQ из того же items ${onHome}; ld+json вне главной: ${leaks.length ? show(leaks) : "нет"} | ` +
      `ожид.: один граф, адреса на ${hostOf(SITE)}, FAQPage ≡ отрисованному FAQ`;
    return ok ? pass(detail) : fail(detail);
  },
};

const SEO8: Check = {
  id: "SEO.8", wp: "SEO", kind: "unit",
  title: "GET /llms.txt: 200 text/plain; utf-8, ссылки только на основной домен («/», /check, /chat — без чата нет), тексты — со страницы (FAQ, «Что покажем»)",
  async run(): Promise<Verdict> {
    const { SITE, SITE_DESCRIPTION } = await site();
    const rel = "apps/web/app/llms.txt/route.ts";
    if (!fs.existsSync(path.join(REPO_ROOT, rel))) return fail(`нет ${rel} | ожид.: route handler GET → text/plain`);
    const route = (await import("../../app/llms.txt/route")) as { GET: () => Response | Promise<Response>; dynamic?: string };
    const content = (await import("../../app/home-content")) as ContentMod;
    const rows: string[] = [];
    let ok = route.dynamic === "force-static";
    rows.push(`dynamic=${show(route.dynamic ?? null)}`);
    for (const chat of ["1", "0"] as const) {
      const res = await withEnv({ SO_CHAT: chat }, () => route.GET());
      const text = await res.text();
      const ctype = res.headers.get("content-type") ?? "";
      const urls = [...text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0]);
      const foreign = urls.filter((u) => hostOf(u) !== hostOf(SITE) || !u.startsWith("https://"));
      const has = (u: string) => text.includes(`](${u})`);
      const want = [`${SITE}/`, `${SITE}/check`, ...(chat === "1" ? [`${SITE}/chat`] : [])];
      const missing = want.filter((u) => !has(u));
      const chatLeak = chat === "0" && urls.some((u) => /\/chat\b/.test(u));
      const faqMissing = content.faq(chat === "1").map((x) => x.q).filter((q) => !text.includes(q));
      const featMissing = content.FEATURES.filter((f) => !text.includes(`${f.t}: ${f.d}`)).map((f) => f.t);
      const good = res.status === 200 && /^text\/plain;\s*charset=utf-8$/i.test(ctype) && foreign.length === 0 && missing.length === 0 &&
        !chatLeak && faqMissing.length === 0 && featMissing.length === 0 && text.includes(SITE_DESCRIPTION) && !/<html|<!doctype/i.test(text);
      ok &&= good;
      rows.push(`SO_CHAT=${chat}: status ${res.status}, «${ctype}», ${text.length} знаков, ссылок ${urls.length}, чужих ${foreign.length ? show(foreign) : "нет"}` +
        `${missing.length ? `, нет ссылок ${show(missing)} ✗` : ""}${chatLeak ? ", /chat при SO_CHAT=0 ✗" : ""}` +
        `${faqMissing.length ? `, нет вопросов FAQ ${show(faqMissing)} ✗` : ""}${featMissing.length ? `, нет пунктов «Что покажем» ${show(featMissing)} ✗` : ""}`);
    }
    const detail = `${rows.join(" | ")} | ожид.: статический text/plain, абсолютные ссылки на ${hostOf(SITE)}, тексты из app/home-content.tsx и lib/site.ts`;
    return ok ? pass(detail) : fail(detail);
  },
};

const SEO9: Check = {
  id: "SEO.9", wp: "SEO", kind: "unit",
  title: "Метрика выключена по умолчанию: <Metrika> только при NEXT_PUBLIC_YM_ID; init с clickmap/trackLinks/accurateTrackBounce/webvisor, хит на навигацию, reachGoal без счётчика — no-op",
  async run(): Promise<Verdict> {
    await site();
    const metrika = (await import("../../app/metrika")) as typeof import("../../app/metrika");
    const isMetrika = (el: ReactElement<Record<string, unknown>>) => el.type === metrika.Metrika;
    const kids = { children: "x" } as { children: ReactNode };
    const off = (await withEnv(BASE_ENV, () => import("../../app/layout"))) as LayoutMod;
    const on = (await withEnv({ ...BASE_ENV, NEXT_PUBLIC_YM_ID: "99999999" }, () => import(fileUrl("layout.tsx", "?ym=1")))) as LayoutMod;
    const offEls = findAll(off.default(kids), isMetrika);
    const onEls = findAll(on.default(kids), isMetrika);
    const onId = onEls[0]?.props.id;
    // reachGoal без счётчика: окна нет (Node) и init не вызывался — не бросает
    let noop: string;
    try { metrika.reachGoal("check_submit"); noop = "не бросает"; } catch (e) { noop = `БРОСАЕТ ${cut(String(e), 80)}`; }
    const src = readSrc("apps/web/app/metrika.tsx");
    const opts = ["clickmap", "trackLinks", "accurateTrackBounce", "webvisor"].filter((k) => !new RegExp(`\\b${k}:\\s*true\\b`).test(src));
    const statics: [string, boolean][] = [
      ['"use client"', /^\s*"use client";/.test(src)],
      ["defer:true (хит вручную)", /\bdefer:\s*true\b/.test(src)],
      ["usePathname+useSearchParams", /\busePathname\(\)/.test(src) && /\buseSearchParams\(\)/.test(src)],
      ["<Suspense>", /<Suspense\b/.test(src)],
      ['хит "hit"', /"hit"/.test(src)],
      ["m убирается из адреса хита", /\.delete\("m"\)/.test(src)],
      ["export reachGoal", /export function reachGoal\b/.test(src)],
      ["номер не в исходнике", !/\bym\(\s*\d{5,}|watch\/\d{5,}/.test(src + readSrc("apps/web/app/layout.tsx"))],
    ];
    const badStatic = statics.filter(([, v]) => !v).map(([k]) => k);
    const ok = offEls.length === 0 && onEls.length === 1 && onId === "99999999" && noop === "не бросает" && opts.length === 0 && badStatic.length === 0;
    const detail = `layout без NEXT_PUBLIC_YM_ID: <Metrika> ${offEls.length} (ожид. 0); с NEXT_PUBLIC_YM_ID=99999999: ${onEls.length}, id=${show(onId ?? null)} (ожид. 1, "99999999"); ` +
      `reachGoal без счётчика ${noop}; init: нет опций ${opts.length ? show(opts) : "— все четыре есть"}; ` +
      `metrika.tsx: ${statics.map(([k, v]) => `${k} ${v ? "да" : "НЕТ"}`).join(", ")} | ожид.: счётчик только по env сборки, номер в репозиторий не пишется`;
    return ok ? pass(detail) : fail(detail);
  },
};

const YM = /\bym-hide-content\b[^"]*\bym-disable-keys\b|\bym-disable-keys\b[^"]*\bym-hide-content\b/;
const SEO10: Check = {
  id: "SEO.10", wp: "SEO", kind: "static",
  title: "Вебвизор не записывает ввод (ym-hide-content ym-disable-keys у полей главной, чата и отчёта) и цели data-goal на месте (check_submit, chat_open, login_click)",
  async run(): Promise<Verdict> {
    // Главная — по отрисованному HTML (что увидит Вебвизор), остальное — по исходникам
    const html = await renderHome("1");
    const tag = (re: RegExp) => [...html.matchAll(re)].map((m) => m[0]);
    const inputs = ["q", "promised", "m"].map((id) => {
      const t = tag(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`, "g"))[0] ?? "";
      return { id, ok: YM.test(t.match(/class="([^"]*)"/)?.[1] ?? "") };
    });
    const thread = readSrc("apps/web/components/Thread.tsx");
    const composer = thread.match(/<ComposerPrimitive\.Input[\s\S]*?\/>/)?.[0] ?? "";
    const composerOk = YM.test(composer.match(/className="([^"]*)"/)?.[1] ?? "");
    const blocks = readSrc("packages/blocks/src/blocks.tsx");
    const reportInputs = ["ask-price", "in-pos", "in-k", "in-pr"].map((id) => {
      const t = blocks.match(new RegExp(`<input\\s+id="${id}"[^>]*?className="([^"]*)"`))?.[1] ?? "";
      return { id, ok: YM.test(t) };
    });
    // Цели: форма /check, форма /chat и примеры вопросов (главная), «Обсудить с ассистентом» (/check), «Войти в кабинет» (шапка)
    const formCheck = tag(/<form\b[^>]*>/g).filter((t) => /action="\/check"/.test(t) && /data-goal="check_submit"/.test(t)).length;
    const formChat = tag(/<form\b[^>]*>/g).filter((t) => /action="\/chat"/.test(t) && /data-goal="chat_open"/.test(t)).length;
    const askLinks = tag(/<a\b[^>]*href="\/chat\?m=[^"]*"[^>]*>/g);
    const askGoal = askLinks.filter((t) => /data-goal="chat_open"/.test(t)).length;
    const login = tag(/<a\b[^>]*>Войти в кабинет<\/a>/g).filter((t) => /data-goal="login_click"/.test(t)).length;
    const checkClient = /href=\{href\}\s+data-goal="chat_open"[^>]*>Обсудить с ассистентом/.test(readSrc("apps/web/app/check/CheckClient.tsx"));
    const msrc = readSrc("apps/web/app/metrika.tsx");
    const listener = /closest<HTMLElement>\("\[data-goal\]"\)/.test(msrc) && /addEventListener\("submit"/.test(msrc) && /addEventListener\("click"/.test(msrc);
    const ok = inputs.every((x) => x.ok) && composerOk && reportInputs.every((x) => x.ok) &&
      formCheck === 1 && formChat === 1 && askLinks.length > 0 && askGoal === askLinks.length && login === 1 && checkClient && listener;
    const yn = (b: boolean) => (b ? "да" : "НЕТ");
    const detail =
      `ym-классы: главная ${inputs.map((x) => `#${x.id} ${yn(x.ok)}`).join(", ")}; чат ComposerPrimitive.Input ${yn(composerOk)}; ` +
      `отчёт ${reportInputs.map((x) => `#${x.id} ${yn(x.ok)}`).join(", ")} | цели: form /check check_submit ${formCheck}, form /chat chat_open ${formChat}, ` +
      `примеры вопросов chat_open ${askGoal}/${askLinks.length}, «Войти в кабинет» login_click ${login}, «Обсудить с ассистентом» chat_open ${yn(checkClient)}, ` +
      `слушатель [data-goal] (submit+click) ${yn(listener)} | ожид.: всё да, по одной форме`;
    return ok ? pass(detail) : fail(detail);
  },
};

/* ───── live: прод (или AUDIT_SEO_BASE — локальный next start; адреса основного домена переписываются на него) ───── */
async function liveGet(pathOrUrl: string): Promise<{ status: number; ctype: string; text: string; url: string; bytes: number }> {
  const { SITE } = await site();
  const base = (process.env.AUDIT_SEO_BASE || SITE).replace(/\/+$/, "");
  const url = pathOrUrl.startsWith(SITE) ? base + pathOrUrl.slice(SITE.length) : pathOrUrl.startsWith("/") ? base + pathOrUrl : pathOrUrl;
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { "user-agent": "so-audit-wp-seo/1 (harness)" } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ctype: r.headers.get("content-type") ?? "", text: buf.toString("utf8"), url, bytes: buf.length };
}
const attr = (tagHtml: string, name: string) => tagHtml.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
const metaProp = (html: string, prop: string) =>
  [...html.matchAll(/<meta\b[^>]*>/g)].map((m) => m[0]).filter((t) => attr(t, "property") === prop).map((t) => unescapeHtml(attr(t, "content") ?? ""));

const SEO11: Check = {
  id: "SEO.11", wp: "SEO", kind: "live",
  title: "Прод: на «/» <link rel=canonical> — основной домен и путь «/»",
  async run(): Promise<Verdict> {
    const { SITE } = await site();
    const r = await liveGet("/");
    const links = [...r.text.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).filter((t) => attr(t, "rel") === "canonical").map((t) => attr(t, "href") ?? "");
    const c = links[0] ?? null;
    const ok = r.status === 200 && links.length === 1 && c != null && hostOf(c) === hostOf(SITE) && c.startsWith("https://") && (new URL(c).pathname === "/");
    const detail = `GET ${r.url} → ${r.status}; canonical ${links.length ? show(links) : "нет"} | ожид.: один, ${SITE} (путь «/»)`;
    return ok ? pass(detail) : fail(detail);
  },
};

const SEO12: Check = {
  id: "SEO.12", wp: "SEO", kind: "live",
  title: "Прод: og:image главной — абсолютный адрес основного домена, отдаётся картинкой (1200×630 в мета)",
  async run(): Promise<Verdict> {
    const { SITE } = await site();
    const r = await liveGet("/");
    const img = metaProp(r.text, "og:image")[0] ?? null;
    if (r.status !== 200 || !img) return fail(`GET ${r.url} → ${r.status}; og:image ${img ?? "нет"} | ожид.: og:image на ${hostOf(SITE)}`);
    const w = metaProp(r.text, "og:image:width")[0] ?? null;
    const h = metaProp(r.text, "og:image:height")[0] ?? null;
    const onSite = hostOf(img) === hostOf(SITE) && img.startsWith("https://");
    const g = onSite ? await liveGet(img) : null;
    const ok = onSite && g != null && g.status === 200 && g.ctype.startsWith("image/") && w === "1200" && h === "630";
    const detail = `og:image ${img} (${w ?? "?"}×${h ?? "?"}); GET ${g ? `${g.url} → ${g.status} «${g.ctype}» ${g.bytes} байт` : "не делали (чужой домен)"} | ` +
      `ожид.: основной домен, 200 image/*, 1200×630`;
    return ok ? pass(detail) : fail(detail);
  },
};

const SEO13: Check = {
  id: "SEO.13", wp: "SEO", kind: "live",
  title: "Прод: /llms.txt — 200 text/plain со ссылками на основной домен",
  async run(): Promise<Verdict> {
    const { SITE } = await site();
    const r = await liveGet("/llms.txt");
    const urls = [...r.text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0]);
    const own = urls.filter((u) => hostOf(u) === hostOf(SITE));
    const ok = r.status === 200 && r.ctype.startsWith("text/plain") && !/<html|<!doctype/i.test(r.text) && own.length > 0 && own.length === urls.length;
    const detail = `GET ${r.url} → ${r.status} «${r.ctype}», ${r.text.length} знаков; ссылок ${urls.length}, на ${hostOf(SITE)} ${own.length} | ` +
      `ожид.: 200 text/plain, все ссылки на основной домен`;
    return ok ? pass(detail) : fail(detail);
  },
};

export const checks: Check[] = [SEO1, SEO2, SEO3, SEO4, SEO5, SEO6, SEO7, SEO8, SEO9, SEO10, SEO11, SEO12, SEO13];
