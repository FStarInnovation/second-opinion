/**
 * WP-TG, группа «static» (docs/PLAN_telegram_bot_2026-10-14.md §6): TG.1, TG.2, TG.7, TG.15, TG.22 — RED до правки,
 * TG.G3 — guard (GREEN уже на d16c809).
 *
 * Исходники разбираются парсером TypeScript из node_modules/typescript, а не регэкспами: литералы, шаблоны, JSX-текст и
 * комментарии различаются точно. «Текст без комментариев» (`codeOnly`) — исходник, где всё, что не входит ни в один токен
 * (пробелы и комментарии, в том числе JSDoc), заменено пробелами; переводы строк сохранены, поэтому номера строк и позиции
 * совпадают с исходником.
 *
 * Код продукта не исполняется. Исключения — модули без побочных эффектов: apps/web/lib/prompt.ts (SYSTEM_PROMPT, если импорт
 * не удался — значение берётся из литерала) и packages/present/src/copy.ts (через tryImport: нет модуля → RED, а не ERROR).
 * Модулей бота и @so/present ещё нет: статических импортов несуществующих модулей здесь нет.
 *
 * `makeStaticChecks(root)` — те же проверки над другим корнем репозитория (самопроверка на эталонных и испорченных деревьях);
 * в харнесе `checks = makeStaticChecks(REPO_ROOT)`.
 */
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";
import { REPO_ROOT, fail, pass, type Check, type Verdict } from "../lib";
import { PRESENT, tryImport, type CopyMod } from "./types";

/* ═══════════════════════════ мелочи ═══════════════════════════ */

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const posix = (p: string) => p.split(path.sep).join("/");
const relOf = (root: string, abs: string) => posix(path.relative(root, abs));
const inside = (abs: string, dir: string) => { const r = path.relative(dir, abs); return !!r && !r.startsWith("..") && !path.isAbsolute(r); };
/** Первые n элементов через «; » и хвост «… ещё K» */
const list = (xs: readonly string[], n: number) => (xs.length <= n ? xs.join("; ") : `${xs.slice(0, n).join("; ")}; … ещё ${xs.length - n}`);
const uniq = <T,>(xs: readonly T[]) => [...new Set(xs)];
const errText = (e: unknown) => cut(oneLine(e instanceof Error ? `${e.name}: ${e.message}` : String(e)), 200);
const readJsonFile = (abs: string): { ok: true; v: Record<string, unknown> } | { ok: false; err: string } => {
  try { return { ok: true, v: JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown> }; } catch (e) { return { ok: false, err: errText(e) }; }
};
const CYR = /\p{Script=Cyrillic}/u;

/* ═══════════════════════════ разбор TypeScript ═══════════════════════════ */

const SCRIPT_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
function scriptKind(file: string): ts.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
interface Parsed { file: string; sf: ts.SourceFile; code: string }
/** Разбор файла: AST (с parent) и текст без комментариев той же длины */
export function parseSource(file: string, text = fs.readFileSync(file, "utf8")): Parsed {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  return { file, sf, code: codeOnly(sf) };
}
const isJsDocNode = (n: ts.Node) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;
/** Текст без комментариев: остаются только символы токенов (getChildren до листьев, JSDoc пропускается), прочее → пробел */
export function codeOnly(sf: ts.SourceFile): string {
  const src = sf.text;
  const keep = new Uint8Array(src.length);
  const visit = (n: ts.Node): void => {
    if (isJsDocNode(n)) return;
    const kids = n.getChildren(sf);
    if (!kids.length) { if (n.end > n.pos) keep.fill(1, n.getStart(sf), n.end); return; }
    for (const k of kids) visit(k);
  };
  visit(sf);
  const out: string[] = new Array(src.length);
  for (let i = 0; i < src.length; i++) { const c = src[i]; out[i] = keep[i] || c === "\n" || c === "\r" ? c : " "; }
  return out.join("");
}
function walk(n: ts.Node, f: (n: ts.Node) => void): void {
  f(n);
  ts.forEachChild(n, (c) => { walk(c, f); });
}
const lineAt = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
/** Строка текста (по позиции) — для контекста в detail */
const lineTextAt = (text: string, pos: number) => {
  const a = text.lastIndexOf("\n", pos - 1) + 1;
  const b = text.indexOf("\n", pos);
  return text.slice(a, b < 0 ? text.length : b);
};
/** Контекст вокруг позиции: «…до [совпадение] после…» в одну строку */
const around = (text: string, i: number, len: number, w = 34) =>
  `${i > w ? "…" : ""}${oneLine(text.slice(Math.max(0, i - w), i + len + w))}${i + len + w < text.length ? "…" : ""}`;
/** Вырезать диапазоны (заменить пробелами, переводы строк сохранить) */
function blank(text: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  const a = text.split("");
  for (const [s, e] of ranges) for (let i = s; i < e && i < a.length; i++) if (a[i] !== "\n" && a[i] !== "\r") a[i] = " ";
  return a.join("");
}
const nodeText = (p: Parsed, n: ts.Node) => p.code.slice(n.getStart(p.sf), n.end);
const squash = (s: string) => s.replace(/\s+/g, "");

/* ───── литералы ───── */
type LitKind = "строка" | "шаблон" | "JSX-текст" | "регэксп";
interface Lit { kind: LitKind; text: string; line: number; start: number }
const decodeJsx = (s: string) =>
  s.replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
/** Все литералы файла вне комментариев: строки (в т. ч. значения JSX-атрибутов), части шаблонов, JSX-текст, регэкспы */
function literalsOf(sf: ts.SourceFile): Lit[] {
  const out: Lit[] = [];
  walk(sf, (n) => {
    let kind: LitKind | null = null;
    let text = "";
    if (ts.isStringLiteral(n)) { kind = "строка"; text = n.text; }
    else if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) { kind = "шаблон"; text = n.text; }
    else if (ts.isJsxText(n)) { kind = "JSX-текст"; text = decodeJsx(n.text); }
    else if (ts.isRegularExpressionLiteral(n)) { kind = "регэксп"; text = n.text; }
    if (kind) { const start = n.getStart(sf); out.push({ kind, text, line: lineAt(sf, start), start }); }
  });
  return out;
}
const litShow = (rel: string, l: Lit) => `${rel}:${l.line} ${l.kind} «${cut(oneLine(l.text), 48)}»`;

/* ───── импорты ───── */
interface ImportRef {
  spec: string | null; via: "import" | "export from" | "import()" | "require()" | "import(тип)" | "import ="; line: number;
  names: { name: string; type: boolean }[]; whole: "namespace" | "all" | null; typeOnly: boolean;
}
function importsOf(sf: ts.SourceFile): ImportRef[] {
  const out: ImportRef[] = [];
  const ln = (n: ts.Node) => lineAt(sf, n.getStart(sf));
  const str = (e: ts.Node | undefined) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null);
  walk(sf, (n) => {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      const typeOnly = !!c?.isTypeOnly;
      const names: ImportRef["names"] = [];
      let whole: ImportRef["whole"] = null;
      if (c?.name) names.push({ name: "default", type: typeOnly });
      const nb = c?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) whole = "namespace";
      else if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) names.push({ name: (e.propertyName ?? e.name).text, type: typeOnly || e.isTypeOnly });
      out.push({ spec: str(n.moduleSpecifier), via: "import", line: ln(n), names, whole, typeOnly });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier) {
      const names: ImportRef["names"] = [];
      let whole: ImportRef["whole"] = null;
      const ec = n.exportClause;
      if (!ec) whole = "all";
      else if (ts.isNamespaceExport(ec)) whole = "namespace";
      else for (const e of ec.elements) names.push({ name: (e.propertyName ?? e.name).text, type: n.isTypeOnly || e.isTypeOnly });
      out.push({ spec: str(n.moduleSpecifier), via: "export from", line: ln(n), names, whole, typeOnly: n.isTypeOnly });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      out.push({ spec: str(n.moduleReference.expression), via: "import =", line: ln(n), names: [], whole: "namespace", typeOnly: n.isTypeOnly });
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.push({ spec: str(n.arguments[0]), via: "import()", line: ln(n), names: [], whole: "namespace", typeOnly: false });
    } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require") {
      out.push({ spec: str(n.arguments[0]), via: "require()", line: ln(n), names: [], whole: "namespace", typeOnly: false });
    } else if (ts.isImportTypeNode(n)) {
      const spec = ts.isLiteralTypeNode(n.argument) ? str(n.argument.literal) : null;
      let q: ts.EntityName | undefined = n.qualifier;
      while (q && ts.isQualifiedName(q)) q = q.left;
      out.push({ spec, via: "import(тип)", line: ln(n), names: q ? [{ name: q.text, type: true }] : [], whole: q ? null : "namespace", typeOnly: true });
    }
  });
  return out;
}

/* ═══════════════════════════ TG.1 — граф импортов двух зон ═══════════════════════════ */

type Zone = "bot" | "present";
const ZONE_DIR: Record<Zone, string> = { bot: "apps/bot/src", present: "packages/present/src" };
const ZONE_NAME: Record<Zone, string> = { bot: "apps/bot/src", present: "@so/present" };
/** Из `ai` в apps/bot/src разрешены только эти значения (плюс любые типы) */
const AI_ALLOWED = ["parseJsonEventStream", "uiMessageChunkSchema", "readUIMessageStream", "generateId"] as const;
/** grammy — только в этих файлах (§3 решение 2, §4.4) */
const GRAMMY_FILES = ["apps/bot/src/main.ts", "apps/bot/src/telegram.ts"];
const IDENTITY_FILE = "apps/bot/src/identity.ts";
/** Хост (в т. ч. поддомены: api.anthropic.com), URL или идентификатор модели («anthropic/claude-…», «openrouter/auto») — §6 TG.1 «хосты» */
const LLM_HOST = /(?:[a-z0-9-]+\.)*(?:openrouter\.ai|anthropic\.com|typesafe\.ai)\b|\b(?:openrouter|anthropic|typesafe)\/[\w.-]+/i;

let aiValueNames: Promise<Set<string> | null> | null = null;
/** Имена значений, которые `ai` экспортирует во время выполнения: импортированное имя вне этого списка — тип */
function aiValues(): Promise<Set<string> | null> {
  return (aiValueNames ??= import("ai").then((m) => new Set(Object.keys(m)), () => null));
}

const pkgOf = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
const isBuiltin = (spec: string) => builtinModules.includes(spec) || builtinModules.includes(spec.split("/")[0]);

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base, ...[".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((e) => base + e),
    ...["index.ts", "index.tsx", "index.js"].map((f) => path.join(base, f))];
  const m = base.match(/\.(m|c)?jsx?$/);
  if (m) {
    const stem = base.slice(0, -m[0].length);
    cands.unshift(stem + (m[1] === "m" ? ".mts" : m[1] === "c" ? ".cts" : ".ts"), stem + ".tsx");
  }
  return cands.find(isFile) ?? null;
}
/** `@so/present/<sub>` → файл в packages/present по exports его package.json (без него — ./src/<sub>.ts) */
function resolvePresent(root: string, spec: string): { file: string | null; why: string } {
  const pkgDir = path.join(root, "packages/present");
  const sub = spec === "@so/present" ? "." : "./" + spec.slice("@so/present/".length);
  const pj = path.join(pkgDir, "package.json");
  let target: string | null = null;
  if (isFile(pj)) {
    const r = readJsonFile(pj);
    if (!r.ok) return { file: null, why: `packages/present/package.json не читается: ${r.err}` };
    const exp = r.v.exports as unknown;
    if (exp === undefined) target = sub === "." ? null : `./src/${sub.slice(2)}.ts`;
    else if (typeof exp === "string") target = sub === "." ? exp : null;
    else if (exp && typeof exp === "object") {
      const v = (exp as Record<string, unknown>)[sub];
      const pick = (x: unknown): string | null =>
        typeof x === "string" ? x : x && typeof x === "object" ? pick((x as Record<string, unknown>).import ?? (x as Record<string, unknown>).default ?? (x as Record<string, unknown>).types) : null;
      target = pick(v);
    }
    if (!target) return { file: null, why: `в exports packages/present/package.json нет «${sub}»` };
  } else target = sub === "." ? null : `./src/${sub.slice(2)}.ts`;
  if (!target) return { file: null, why: "у @so/present нет корневого экспорта" };
  const abs = path.resolve(pkgDir, target);
  return isFile(abs) ? { file: abs, why: "" } : { file: null, why: `нет файла ${relOf(root, abs)}` };
}

interface GraphReport {
  botExists: boolean; presentExists: boolean; botFiles: number; presentFiles: number;
  files: { rel: string; zone: Zone }[]; violations: string[]; externals: Map<string, Set<string>>;
}

/** Обход графа: корни — все файлы apps/bot/src и packages/present/src; рёбра — относительные импорты и @so/present/* */
export async function importGraph(root: string): Promise<GraphReport> {
  const dirs = { bot: path.join(root, ZONE_DIR.bot), present: path.join(root, ZONE_DIR.present) };
  const webDir = path.join(root, "apps/web");
  const zoneOf = (abs: string): Zone | null => (inside(abs, dirs.bot) ? "bot" : inside(abs, dirs.present) ? "present" : null);
  const botExists = isDir(dirs.bot), presentExists = isDir(dirs.present);
  const botRoots = botExists ? scriptFiles(dirs.bot) : [];
  const presentRoots = presentExists ? scriptFiles(dirs.present) : [];
  const queue = [...botRoots, ...presentRoots];
  const seen = new Map<string, Zone>();
  const violations: string[] = [];
  const externals = new Map<string, Set<string>>();
  const ext = (spec: string, rel: string) => { const k = spec.startsWith("node:") ? "node:*" : spec; if (!externals.has(k)) externals.set(k, new Set()); externals.get(k)!.add(rel); };
  const values = await aiValues();

  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    const z = zoneOf(f);
    if (!z) continue;
    seen.set(f, z);
    const rel = relOf(root, f);
    const p = parseSource(f);
    const v = (line: number, msg: string) => violations.push(`${rel}:${line} ${msg}`);

    /* импорты */
    for (const r of importsOf(p.sf)) {
      const spec = r.spec;
      if (spec == null) { v(r.line, `${r.via} с вычисляемым путём — граф не проверить`); continue; }
      const q = `«${spec}»`;
      if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
        const to = resolveRelative(f, spec);
        if (!to) { v(r.line, `относительный импорт ${q} не найден`); continue; }
        const tz = zoneOf(to);
        if (inside(to, webDir)) v(r.line, `${q} → ${relOf(root, to)}: apps/web/** запрещён`);
        else if (!tz) v(r.line, `${q} → ${relOf(root, to)}: относительный импорт за пределы зон (apps/bot/src, packages/present/src)`);
        else if (z === "present" && tz === "bot") v(r.line, `${q} → ${relOf(root, to)}: @so/present не зависит от бота`);
        else if (SCRIPT_RE.test(to)) queue.push(to);
        continue;
      }
      if (path.isAbsolute(spec) || spec.startsWith("file:")) { v(r.line, `${q}: импорт по абсолютному пути`); continue; }
      if (spec.startsWith("node:")) {
        if (z === "present") v(r.line, `${q}: node:* в @so/present запрещён (§3: чистый TS без Node)`); else ext(spec, rel);
        continue;
      }
      if (isBuiltin(spec)) {
        v(r.line, z === "bot" ? `${q}: встроенный модуль без префикса — в зоне бота разрешены только node:*` : `${q}: модуль Node в @so/present запрещён`);
        continue;
      }
      if (spec.startsWith("@/")) { v(r.line, `${q}: @/… — код apps/web (@/lib) запрещён`); continue; }
      const pkg = pkgOf(spec);
      if (pkg.startsWith("@ai-sdk/") || pkg.startsWith("@openrouter/")) { v(r.line, `${q}: провайдеры LLM (@ai-sdk/*, @openrouter/*) запрещены`); continue; }
      if (pkg === "ai") {
        if (z === "present") { v(r.line, `${q}: ai в @so/present запрещён (§3)`); continue; }
        if (spec !== "ai") { v(r.line, `${q}: подпуть ai не разрешён`); continue; }
        if (r.typeOnly) { ext(spec, rel); continue; }
        if (r.via === "import()" || r.via === "require()" || r.via === "import =") { v(r.line, `${q} через ${r.via}: из ai — только именованный статический импорт`); continue; }
        if (r.whole) { v(r.line, `${q}: ${r.whole === "all" ? "export *" : "импорт всего модуля"} из ai — имена не проверить`); continue; }
        const bad = r.names.filter((n) => !n.type && !(AI_ALLOWED as readonly string[]).includes(n.name)
          && (n.name === "default" || (values ? values.has(n.name) : /^[a-z]/.test(n.name))));
        if (bad.length) v(r.line, `из ai разрешены только ${AI_ALLOWED.join(", ")} и типы; ${r.via === "export from" ? "реэкспорт" : "импорт"}: ${bad.map((n) => n.name).join(", ")}`);
        else ext(spec, rel);
        continue;
      }
      if (pkg === "grammy") {
        if (z === "present") v(r.line, `${q}: grammy в @so/present запрещён`);
        else if (!GRAMMY_FILES.includes(rel)) v(r.line, `${q}: grammy импортируют только main.ts и telegram.ts`);
        else ext(spec, rel);
        continue;
      }
      if (pkg === "zod") { ext(spec, rel); continue; }
      if (pkg === "@so/present") {
        if (z === "present") { v(r.line, `${q}: внутри @so/present — только относительные импорты`); continue; }
        const res = resolvePresent(root, spec);
        if (!res.file) { v(r.line, `${q} не разрешается: ${res.why}`); continue; }
        ext(spec, rel);
        queue.push(res.file);
        continue;
      }
      if (pkg === "@so/engine") {
        const sub = spec.slice("@so/engine".length);
        if (sub === "") v(r.line, `${q}: корень @so/engine (build, сеть ISS) запрещён`);
        else if (sub === "/inputs") v(r.line, `${q}: @so/engine/inputs (applyInputs) запрещён`);
        else if (sub === "/contract" || sub === "/format") ext(spec, rel);
        else if (sub === "/config") { if (z === "present") ext(spec, rel); else v(r.line, `${q}: @so/engine/config в графе — только ребро packages/present/src/* → @so/engine/config`); }
        else v(r.line, `${q}: из @so/engine разрешены только contract, format${z === "present" ? ", config" : ""}`);
        continue;
      }
      if (/^react(?:-dom)?$/.test(pkg) || pkg.startsWith("react-") || pkg === "next") { v(r.line, `${q}: React/Next в ${ZONE_NAME[z]} запрещён`); continue; }
      v(r.line, `${q}: внешний пакет не из списка разрешённых для ${ZONE_NAME[z]} (${z === "bot" ? "grammy, ai, @so/present/*, @so/engine/{contract,format}, zod, node:*" : "@so/engine/{contract,format,config}, zod, относительные"})`);
    }

    /* JSX = React */
    let jsxLine = 0;
    walk(p.sf, (n) => { if (!jsxLine && (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n))) jsxLine = lineAt(p.sf, n.getStart(p.sf)); });
    if (jsxLine) v(jsxLine, `JSX в ${ZONE_NAME[z]} (это React)`);

    /* запрещённые имена и токены — в тексте без комментариев */
    const hit = (re: RegExp, what: string) => {
      for (const m of p.code.matchAll(re)) v(lineAt(p.sf, m.index), `${what} «${m[0]}»: ${cut(oneLine(lineTextAt(p.code, m.index)), 70)}`);
    };
    hit(/\b(?:streamText|generateText|convertToModelMessages)\b/g, "решения модели");
    hit(/\btool\s*\(/g, "определение инструмента");
    hit(/(?:ANTHROPIC_|OPENROUTER_|TYPESAFE_|JEV_|LLM_)/g, "имя ключа/настройки LLM или Jev");
    /* литералы: хосты, URL и идентификаторы моделей LLM/Jev — во всех зонах; просто имя провайдера — только в зоне бота
       (у бота своих текстов нет, §4.1; в packages/present/src/copy.ts владелец может назвать обработчика в BOT.privacy, §8) */
    for (const l of literalsOf(p.sf)) {
      if (l.kind !== "строка" && l.kind !== "шаблон") continue;
      const where = `${l.kind === "строка" ? "строке" : "шаблоне"} «${cut(oneLine(l.text), 50)}»`;
      const host = l.text.match(LLM_HOST);
      if (host) { v(l.line, `хост/модель LLM/Jev «${host[0]}» в ${where}`); continue; }
      const word = z === "bot" ? l.text.match(/openrouter|anthropic|typesafe/i) : null;
      if (word) v(l.line, `имя провайдера LLM/Jev «${word[0]}» в литерале бота (своих текстов у бота нет, §4.1) — ${where}`);
    }
    walk(p.sf, (n) => {
      if (ts.isIdentifier(n) && /^(?:openrouter|anthropic|typesafe)$/i.test(n.text)) v(lineAt(p.sf, n.getStart(p.sf)), `идентификатор провайдера «${n.text}»`);
    });
    /* username / first_name / last_name: везде, кроме чтения me.username в sameBot (identity.ts) */
    const allowed: [number, number][] = [];
    if (rel === IDENTITY_FILE) {
      const inSameBot = (n: ts.Node) => {
        for (let a = n.parent; a; a = a.parent) {
          if ((ts.isFunctionDeclaration(a) || ts.isFunctionExpression(a)) && a.name?.text === "sameBot") return true;
          if (ts.isVariableDeclaration(a) && ts.isIdentifier(a.name) && a.name.text === "sameBot") return true;
        }
        return false;
      };
      walk(p.sf, (n) => {
        if (ts.isPropertyAccessExpression(n) && n.name.text === "username" && inSameBot(n)) allowed.push([n.name.getStart(p.sf), n.name.end]);
        // тип параметра sameBot(me: { username?: string }) — объявление типа, не чтение данных
        if (ts.isPropertySignature(n) && ts.isIdentifier(n.name) && n.name.text === "username") allowed.push([n.name.getStart(p.sf), n.name.end]);
      });
    }
    for (const m of p.code.matchAll(/\b(?:username|first_name|last_name)\b/g)) {
      if (allowed.some(([s, e]) => m.index >= s && m.index < e)) continue;
      v(lineAt(p.sf, m.index), `персональные данные Telegram «${m[0]}»${rel === IDENTITY_FILE ? " (в identity.ts допустимо только чтение me.username в sameBot)" : ""}: ${cut(oneLine(lineTextAt(p.code, m.index)), 70)}`);
    }
  }
  const files = [...seen].map(([f, zone]) => ({ rel: relOf(root, f), zone }));
  return { botExists, presentExists, botFiles: botRoots.length, presentFiles: presentRoots.length, files, violations, externals };
}

function scriptFiles(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile() && SCRIPT_RE.test(e.name)) out.push(p);
    }
  };
  rec(dir);
  return out.sort();
}

async function runTG1(root: string): Promise<Verdict> {
  const g = await importGraph(root);
  const presentNote = g.presentExists ? `packages/present/src: ${g.presentFiles} файлов` : "packages/present/src тоже нет (шаг 2)";
  const want = "ожид.: apps/bot/src есть; граф apps/bot/src + packages/present/src без нарушений §6 TG.1 (И1)";
  if (!g.botExists) {
    const pv = g.violations.length ? `; нарушения в @so/present уже есть (${g.violations.length}): ${list(g.violations, 4)}` : "";
    return fail(`нет каталога apps/bot/src (${isDir(path.join(root, "apps/bot")) ? "в apps/bot нет src" : "нет и apps/bot; после шага 1а там будет только package.json"}); ожидаемо до шага 5; ${presentNote}${pv} | ${want}`);
  }
  if (!g.botFiles) return fail(`apps/bot/src пуст: ни одного .ts — проверять нечего; ожидаемо до шага 5 | ${want}`);
  const byZone = (z: Zone) => g.files.filter((f) => f.zone === z).length;
  const exts = [...g.externals].sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => `${k}${k === "grammy" ? ` (${[...s].map((x) => path.basename(x)).join(", ")})` : ""}`);
  const summary = `граф: ${g.files.length} файлов (apps/bot/src ${byZone("bot")}, packages/present/src ${byZone("present")}); внешние спецификаторы: ${exts.join(", ") || "нет"}`;
  if (g.violations.length) return fail(`нарушений ${g.violations.length}: ${list(g.violations, 8)} | ${summary} | ${want}`);
  return pass(`${summary}; нарушений нет (импорты по зонам, решения модели, ключи и хосты LLM/Jev, username/first_name/last_name)`);
}

/* ═══════════════════════════ TG.2 — кириллица в литералах apps/bot/src ═══════════════════════════ */

function runTG2(root: string): Verdict {
  const dir = path.join(root, ZONE_DIR.bot);
  const want = "ожид.: в строковых и шаблонных литералах apps/bot/src нет кириллицы — все тексты из @so/present/copy";
  if (!isDir(dir)) return fail(`нет каталога apps/bot/src (${isDir(path.join(root, "apps/bot")) ? "в apps/bot нет src" : "нет и apps/bot; после шага 1а там будет только package.json"}); ожидаемо до шага 5 | ${want}`);
  const files = scriptFiles(dir);
  if (!files.length) return fail(`apps/bot/src пуст: ни одного .ts — проверять нечего; ожидаемо до шага 5 | ${want}`);
  const hits: string[] = [];
  let lits = 0;
  for (const f of files) {
    const p = parseSource(f);
    const rel = relOf(root, f);
    for (const l of literalsOf(p.sf)) {
      if (l.kind === "регэксп") continue;
      lits++;
      if (CYR.test(l.text)) hits.push(litShow(rel, l));
    }
  }
  const scope = `${files.length} файлов, ${lits} литералов (строки, шаблоны, JSX-текст; комментарии не в счёт)`;
  return hits.length ? fail(`кириллица в литералах: ${hits.length} — ${list(hits, 6)} | ${scope} | ${want}`) : pass(`${scope}; кириллицы нет`);
}

/* ═══════════════════════════ TG.7 — packages/blocks/src без своих текстов ═══════════════════════════ */

const BLOCK_FILES = ["blocks.tsx", "branches.tsx", "ReportView.tsx", "ui.tsx"] as const;
const UI_MOVED = ["pct2", "pctMax", "cap1", "scoreTone", "liquidityTone"] as const;
const FMT_NAMES = ["fmt", "fmtMax", "CONFIG"] as const;
const FMT_OWNERS = ["InputsPanel", "AskPrice"] as const;
/** Константа пределов цены предложения (И4, решение владельца 20.10.2026): из неё строится ReportInputsSchema.offer_price_pct
 *  (contract.ts) и проверка AskPrice; значение схемы (zod) клиентский код @so/blocks не импортирует */
const PRICE_CONST = "CONFIG.inputs.offerPricePct";
const PRICE_CONFIG_SPEC = "@so/engine/config";
const CONFIG_REL = "packages/engine/src/config.ts";
const CONTRACT_REL = "packages/engine/src/contract.ts";
const CONTRACT_SPEC = "@so/engine/contract";
const CMP_OPS = new Set([
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/** Объявления верхнего уровня: имя → узел (функция или объявление переменной) */
interface TopDecl { name: string; node: ts.Node; exported: boolean }
function topDecls(sf: ts.SourceFile): Map<string, TopDecl> {
  const m = new Map<string, TopDecl>();
  const isExp = (s: ts.Node) => ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword);
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) m.set(s.name.text, { name: s.name.text, node: s, exported: isExp(s) });
    else if (ts.isVariableStatement(s))
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) m.set(d.name.text, { name: d.name.text, node: d, exported: isExp(s) });
  }
  // export { a, b } без from — тоже публичные
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause))
      for (const e of s.exportClause.elements) { const d = m.get((e.propertyName ?? e.name).text); if (d) d.exported = true; }
  }
  return m;
}
/** Верхнеуровневое объявление, внутри которого лежит позиция */
function ownerAt(decls: Map<string, TopDecl>, sf: ts.SourceFile, pos: number): TopDecl | null {
  for (const d of decls.values()) if (pos >= d.node.getStart(sf) && pos < d.node.end) return d;
  return null;
}
/** Обращения к имени (идентификаторы-ссылки: не имя объявления, не имя свойства после точки, не ключ, не импорт) */
function refsTo(sf: ts.SourceFile, name: string): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  walk(sf, (n) => {
    if (!ts.isIdentifier(n) || n.text !== name) return;
    const p = n.parent;
    if (!p) return;
    if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === n) return;
    if (ts.isPropertyAccessExpression(p) && p.name === n) return;
    if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === n) return;
    if (ts.isJsxAttribute(p) && p.name === n) return;
    if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return;
    out.push(n);
  });
  return out;
}
/** Корни и их «собственные» помощники верхнего уровня: не экспортируются и используются только внутри уже собственных */
function ownedSet(sf: ts.SourceFile, roots: readonly string[]): { decls: Map<string, TopDecl>; owned: Set<string> } {
  const decls = topDecls(sf);
  const owned = new Set(roots.filter((r) => decls.has(r)));
  for (let changed = true; changed;) {
    changed = false;
    for (const d of decls.values()) {
      if (owned.has(d.name) || d.exported) continue;
      const refs = refsTo(sf, d.name).filter((r) => !(r.getStart(sf) >= d.node.getStart(sf) && r.end <= d.node.end));
      if (refs.length && refs.every((r) => { const o = ownerAt(decls, sf, r.getStart(sf)); return o != null && owned.has(o.name); })) { owned.add(d.name); changed = true; }
    }
  }
  return { decls, owned };
}

/* ───── константа пределов цены (TG.7 (5)) ───── */

/** Обёртки, не меняющие значения: скобки, `as`, `satisfies`, `!` */
const unwrapExpr = (e: ts.Node): ts.Node => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
  return x;
};
/** Инициализатор свойства объектного литерала по имени (без обёрток) */
const propInit = (o: ts.ObjectLiteralExpression, name: string): ts.Node | null => {
  for (const pr of o.properties)
    if (ts.isPropertyAssignment(pr) && (ts.isIdentifier(pr.name) || ts.isStringLiteral(pr.name)) && pr.name.text === name) return unwrapExpr(pr.initializer);
  return null;
};
/** Значения константы из исходника config.ts: `CONFIG = { …, inputs: { offerPricePct: { min: <число>, max: <число> } } }` */
function priceConstValues(root: string): { ok: true; min: number; max: number; line: number } | { ok: false; detail: string } {
  const abs = path.join(root, CONFIG_REL);
  if (!isFile(abs)) return { ok: false, detail: `нет ${CONFIG_REL}` };
  const p = parseSource(abs);
  let opp: ts.ObjectLiteralExpression | null = null;
  walk(p.sf, (n) => {
    if (opp || !ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== "CONFIG" || !n.initializer) return;
    const cfg = unwrapExpr(n.initializer);
    const inputs = ts.isObjectLiteralExpression(cfg) ? propInit(cfg, "inputs") : null;
    const o = inputs && ts.isObjectLiteralExpression(inputs) ? propInit(inputs, "offerPricePct") : null;
    if (o && ts.isObjectLiteralExpression(o)) opp = o;
  });
  const found = opp as ts.ObjectLiteralExpression | null;
  if (!found) return { ok: false, detail: `в ${CONFIG_REL} нет ${PRICE_CONST} = { min, max }` };
  const num = (k: string) => { const e = propInit(found, k); return e && ts.isNumericLiteral(e) ? Number(e.text) : null; };
  const [min, max] = [num("min"), num("max")];
  if (min == null || max == null || !(min < max)) return { ok: false, detail: `${CONFIG_REL}: ${PRICE_CONST} = ${oneLine(nodeText(p, found))} — нужны числовые литералы min < max` };
  return { ok: true, min, max, line: lineAt(p.sf, found.getStart(p.sf)) };
}

type PriceRef = "obj" | "min" | "max";
/**
 * Выражения файла, дающие константу пределов цены или её границу: `CONFIG.inputs.offerPricePct[.min|.max]`, где CONFIG — значение,
 * импортированное из модуля config (`{ CONFIG }`, `{ CONFIG as X }`, `* as ns` → `ns.CONFIG`), и псевдонимы любой глубины:
 * `const P = CONFIG.inputs.offerPricePct`, `const lo = P.min`, `const { min, max: hi } = P`. Затенение имён не учитывается.
 */
function priceRefs(p: Parsed, specs: readonly string[]): { kind: (e: ts.Node) => PriceRef | null; bindings: string[] } {
  const bases = new Set<string>();
  const bindings: string[] = [];
  for (const st of p.sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !specs.includes(st.moduleSpecifier.text)) continue;
    const c = st.importClause;
    if (!c || c.isTypeOnly) continue;
    const nb = c.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) { bases.add(`${nb.name.text}.${PRICE_CONST}`); bindings.push(`* as ${nb.name.text} из «${st.moduleSpecifier.text}»`); }
    else if (nb && ts.isNamedImports(nb))
      for (const e of nb.elements)
        if (!e.isTypeOnly && (e.propertyName ?? e.name).text === "CONFIG") {
          bases.add(PRICE_CONST.replace(/^CONFIG/, e.name.text));
          bindings.push(`${e.name.text === "CONFIG" ? "CONFIG" : `CONFIG as ${e.name.text}`} из «${st.moduleSpecifier.text}»`);
        }
  }
  const obj = new Set<string>(), mins = new Set<string>(), maxs = new Set<string>();
  const kind = (e0: ts.Node): PriceRef | null => {
    const e = unwrapExpr(e0);
    if (ts.isIdentifier(e)) return obj.has(e.text) ? "obj" : mins.has(e.text) ? "min" : maxs.has(e.text) ? "max" : null;
    const t = normAccess(nodeText(p, e));
    if (bases.has(t)) return "obj";
    const m = /^(.*)\.(min|max)$/.exec(t);
    return m && (bases.has(m[1]) || obj.has(m[1])) ? (m[2] as PriceRef) : null;
  };
  for (let changed = true, i = 0; changed && i < 8; i++) {
    changed = false;
    walk(p.sf, (n) => {
      if (!ts.isVariableDeclaration(n) || !n.initializer) return;
      const k = kind(n.initializer);
      const add = (set: Set<string>, name: string) => { if (!set.has(name)) { set.add(name); changed = true; } };
      if (ts.isIdentifier(n.name)) { if (k) add(k === "obj" ? obj : k === "min" ? mins : maxs, n.name.text); }
      else if (ts.isObjectBindingPattern(n.name) && k === "obj")
        for (const el of n.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const prop = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)) ? el.propertyName.text : el.name.text;
          if (prop === "min") add(mins, el.name.text);
          else if (prop === "max") add(maxs, el.name.text);
        }
    });
  }
  return { kind, bindings };
}
/** Числовой литерал (в т. ч. с унарным минусом) → значение */
const numLit = (e: ts.Node): number | null => {
  const x = unwrapExpr(e);
  return ts.isNumericLiteral(x) ? Number(x.text)
    : ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(x.operand) ? -Number(x.operand.text) : null;
};
/** `a op b` → `b op' a`: `MIN <= n` ≡ `n >= MIN` */
const FLIP: Partial<Record<ts.SyntaxKind, ts.SyntaxKind>> = {
  [ts.SyntaxKind.LessThanToken]: ts.SyntaxKind.GreaterThanToken, [ts.SyntaxKind.GreaterThanToken]: ts.SyntaxKind.LessThanToken,
  [ts.SyntaxKind.LessThanEqualsToken]: ts.SyntaxKind.GreaterThanEqualsToken, [ts.SyntaxKind.GreaterThanEqualsToken]: ts.SyntaxKind.LessThanEqualsToken,
};
/** Сравнение значения с границей, совместимое со схемой (min()/max() zod — включительно): принять `n >= min` / `n <= max`
 *  или отклонить `n < min` / `n > max`. `n > min`, `n <= min`, `n < max`, `n >= max` и равенства — граница исключительно или точка */
const BOUND_OPS: Record<"min" | "max", ts.SyntaxKind[]> = {
  min: [ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanToken],
  max: [ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken],
};
/**
 * Цепочка offer_price_pct — белый список (ревью 20.10, раунд 2, R1r2-1): корень — ровно `z.number()` (z из "zod"), затем
 * `.min(<P>.min)` / `.gte(<P>.min)` и `.max(<P>.max)` / `.lte(<P>.max)` ровно по разу, а из прочего — только вызовы, не меняющие
 * множества принимаемых чисел: `.nullable()`, `.optional()`, `.finite()` (при min/max смысла не меняет) и `.describe(<строка>)`.
 * Любой другой вызов (int, multipleOf, step, refine, superRefine, transform, pipe, catch, default, or, and, brand, positive, gt,
 * lt, …) делает схему уже или шире константы, а форма AskPrice об этом не знает
 */
const ZOD_MIN = ["min", "gte"], ZOD_MAX = ["max", "lte"], ZOD_NOARG = ["nullable", "optional", "finite"];

/** Локальные имена значения z из "zod": `import { z }`, `import { z as X }`, `import * as X`, `import X` (default) */
function zodLocals(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "zod") continue;
    const c = st.importClause;
    if (!c || c.isTypeOnly) continue;
    if (c.name) out.add(c.name.text);
    const nb = c.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) out.add(nb.name.text);
    else if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly && (e.propertyName ?? e.name).text === "z") out.add(e.name.text);
  }
  return out;
}

/** contract.ts: offer_price_pct в ReportInputsSchema — ровно `z.number().min(<P>.min).max(<P>.max)` от той же константы, без
 *  литералов и без других уточнений (белый список выше) */
function contractPriceProblems(root: string): { problems: string[]; note: string } {
  const abs = path.join(root, CONTRACT_REL);
  if (!isFile(abs)) return { problems: [`нет ${CONTRACT_REL}`], note: "" };
  const p = parseSource(abs);
  const refs = priceRefs(p, ["./config", "./config.ts", "./config.js", PRICE_CONFIG_SPEC]);
  const zl = zodLocals(p.sf);
  const fields: ts.PropertyAssignment[] = [];
  let declared = false;
  walk(p.sf, (n) => {
    if (declared || !ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== "ReportInputsSchema" || !n.initializer) return;
    declared = true;
    walk(n.initializer, (m) => { if (ts.isPropertyAssignment(m) && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) && m.name.text === "offer_price_pct") fields.push(m); });
  });
  if (!fields.length) return { problems: [`${CONTRACT_REL}: в ReportInputsSchema нет offer_price_pct (свойством «offer_price_pct: z.number()…»)`], note: "" };
  const f = fields[0];
  const line = lineAt(p.sf, f.getStart(p.sf));
  const head = `${CONTRACT_REL}:${line} offer_price_pct`;
  const want = `нужно z.number().min(${PRICE_CONST}.min).max(${PRICE_CONST}.max), из прочего — только .nullable(), .optional(), .finite(), .describe(«строка»)`;
  if (fields.length > 1)
    return { problems: [`${head}: в ReportInputsSchema ${fields.length} свойства offer_price_pct (строки ${fields.map((x) => lineAt(p.sf, x.getStart(p.sf))).join(", ")}) — ${want}`], note: "" };
  const out: string[] = [];
  // цепочка снаружи внутрь: X.describe(…) ← X.optional() ← … ← z.number()
  const calls: { name: string; args: readonly ts.Expression[] }[] = [];
  let x = unwrapExpr(f.initializer);
  let rootObj: ts.Node | null = null;
  if (!ts.isCallExpression(x))
    out.push(`инициализатор «${cut(oneLine(nodeText(p, x)), 60)}» — не цепочка вызовов (идентификатор или общая переменная прячут уточнения схемы)`);
  else
    for (;;) {
      const call = x as ts.CallExpression;
      const callee = unwrapExpr(call.expression);
      if (!ts.isPropertyAccessExpression(callee)) { out.push(`вызов «${cut(oneLine(nodeText(p, call)), 60)}» — не метод цепочки`); break; }
      calls.unshift({ name: callee.name.text, args: call.arguments });
      const obj = unwrapExpr(callee.expression);
      if (!ts.isCallExpression(obj)) { rootObj = obj; break; }
      x = obj;
    }
  const shown = (c: { name: string; args: readonly ts.Expression[] }) => `.${c.name}(${c.args.map((a) => cut(oneLine(nodeText(p, a)), 40)).join(", ")})`;
  if (calls.length && rootObj) {
    const r = calls[0];
    const zOk = ts.isIdentifier(rootObj) && zl.has(rootObj.text);
    if (!zOk || r.name !== "number" || r.args.length)
      out.push(`корень цепочки «${cut(oneLine(nodeText(p, rootObj)), 30)}${shown(r)}», а нужен z.number() без аргументов${zOk ? "" : " (z — из \"zod\")"}`);
    const seen = { min: 0, max: 0 };
    for (const c of calls.slice(1)) {
      const b = ZOD_MIN.includes(c.name) ? "min" : ZOD_MAX.includes(c.name) ? "max" : null;
      if (b) {
        const a = c.args.length === 1 ? c.args[0] : null;
        const k = a ? refs.kind(a) : null;
        if (k === b) seen[b]++;
        else out.push(`${shown(c)} — ${c.args.length !== 1 ? "нужен ровно один аргумент" : a && numLit(a) != null ? "числовой литерал" : k ? `${PRICE_CONST}.${k}` : "выражение не от константы"} вместо ${PRICE_CONST}.${b}`);
      } else if (ZOD_NOARG.includes(c.name)) {
        if (c.args.length) out.push(`${shown(c)} — с аргументами`);
      } else if (c.name === "describe") {
        if (!(c.args.length === 1 && (ts.isStringLiteral(c.args[0]) || ts.isNoSubstitutionTemplateLiteral(c.args[0])))) out.push(`${shown(c)} — описание не строковым литералом`);
      } else out.push(`схема уже или шире константы: ${shown(c)}`);
    }
    for (const b of ["min", "max"] as const)
      if (seen[b] !== 1) out.push(seen[b] ? `.${b}(${PRICE_CONST}.${b}) — ${seen[b]} раза, нужен ровно один` : `нет .${b}(${PRICE_CONST}.${b})`);
  }
  if (!refs.bindings.length) out.push(`CONFIG не импортирован из ./config (${PRICE_CONFIG_SPEC})`);
  return out.length
    ? { problems: [`${head} не совпадает с ${PRICE_CONST} — ${out.join("; ")} (${want}; И4: схема и AskPrice — из одной константы)`], note: "" }
    : { problems: [], note: `${head} — z.number()${calls.slice(1).map((c) => c.name === "describe" ? ".describe(…)" : shown(c)).join("")}: границы из ${PRICE_CONST}, других уточнений нет` };
}

interface Tg7Report { problems: string[]; notes: string[] }
function analyzeBlocks(root: string): Tg7Report {
  const dir = path.join(root, "packages/blocks/src");
  const problems: string[] = [];
  const notes: string[] = [];
  const parsed: Partial<Record<(typeof BLOCK_FILES)[number], Parsed>> = {};
  for (const f of BLOCK_FILES) {
    const abs = path.join(dir, f);
    if (!isFile(abs)) { problems.push(`нет файла packages/blocks/src/${f}`); continue; }
    parsed[f] = parseSource(abs);
  }
  /* (1) кириллица в литералах и JSX-тексте вне комментариев */
  const cyr: string[] = [];
  const perFile: string[] = [];
  let litTotal = 0;
  for (const f of BLOCK_FILES) {
    const p = parsed[f];
    if (!p) continue;
    const ls = literalsOf(p.sf);
    litTotal += ls.length;
    const h = ls.filter((l) => CYR.test(l.text));
    if (h.length) { perFile.push(`${f} ${h.length}`); cyr.push(...h.map((l) => litShow(f, l))); }
  }
  if (cyr.length) problems.push(`кириллица в литералах/JSX-тексте: ${cyr.length} (${perFile.join(", ")}) — ${list(cyr, 4)}`);
  else notes.push(`кириллицы нет (${litTotal} литералов в 4 файлах)`);

  /* (2) ui.tsx: pct2, pctMax, cap1, scoreTone, liquidityTone переехали в VM и @so/present/report */
  const ui = parsed["ui.tsx"];
  if (ui) {
    const found: string[] = [];
    for (const name of UI_MOVED) {
      const lines = uniq([...ui.code.matchAll(new RegExp(`\\b${name}\\b`, "g"))].map((m) => lineAt(ui.sf, m.index)));
      if (lines.length) found.push(`${name} (:${lines.slice(0, 3).join(",:")})`);
    }
    if (found.length) problems.push(`ui.tsx: остались ${found.join(", ")} — должны уйти в VM/@so/present/report`);
  }

  /* (3) blocks.tsx: fmt/fmtMax/CONFIG только внутри InputsPanel и AskPrice (и их собственных помощников) */
  const bl = parsed["blocks.tsx"];
  if (bl) {
    const { decls, owned } = ownedSet(bl.sf, FMT_OWNERS);
    const outside: string[] = [];
    const usedIn = new Set<string>();
    for (const name of FMT_NAMES) {
      for (const r of refsTo(bl.sf, name)) {
        if (ts.isExportSpecifier(r.parent)) { outside.push(`:${lineAt(bl.sf, r.getStart(bl.sf))} ${name} (реэкспорт)`); continue; }
        const o = ownerAt(decls, bl.sf, r.getStart(bl.sf));
        if (!o || !owned.has(o.name)) outside.push(`:${lineAt(bl.sf, r.getStart(bl.sf))} ${name} в ${o ? o.name : "верхнем уровне"}`);
        else usedIn.add(o.name);
      }
    }
    if (outside.length) problems.push(`blocks.tsx: fmt/fmtMax/CONFIG вне InputsPanel и AskPrice — ${list(uniq(outside), 6)} (числа и тон — из VM)`);
    else notes.push(`fmt/fmtMax/CONFIG только в ${[...usedIn].join(", ") || "—"} (InputsPanel, AskPrice и их собственные помощники)`);

    /* (5) AskPrice: цена — через константу CONFIG.inputs.offerPricePct из @so/engine/config (та же, из которой строится схема),
     *     границы включительно, без числовых литералов границ; значения схемы (zod) в packages/blocks/src нет */
    const ask = decls.get("AskPrice");
    if (!ask) problems.push("blocks.tsx: нет AskPrice");
    else {
      const cv = priceConstValues(root);
      if (!cv.ok) problems.push(cv.detail);
      // AskPrice и его собственные помощники верхнего уровня
      const askOwned = ownedSet(bl.sf, ["AskPrice"]).owned;
      const ownedNodes = [...decls.values()].filter((d) => askOwned.has(d.name));
      const refs = priceRefs(bl, [PRICE_CONFIG_SPEC]);
      const at = (n: ts.Node) => `:${lineAt(bl.sf, n.getStart(bl.sf))}`;
      const isLen = (e: ts.Node) => { const x = unwrapExpr(e); return ts.isPropertyAccessExpression(x) && x.name.text === "length"; };
      const okCmp: Record<"min" | "max", Map<string, string>> = { min: new Map(), max: new Map() };
      const badCmp: string[] = [];
      const lits: string[] = [];
      const litPos = new Set<number>(); // литералы, уже показанные в сравнении
      const schemaUse: string[] = [];
      const boundVals = cv.ok ? [cv.min, cv.max] : [];
      for (const d of ownedNodes) {
        walk(d.node, (n) => {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["safeParse", "parse", "safeParseAsync", "parseAsync"].includes(n.expression.name.text) &&
            normAccess(nodeText(bl, n.expression.expression)) !== "JSON")
            schemaUse.push(`${at(n)} «${cut(oneLine(nodeText(bl, n)), 70)}»`);
          if (ts.isIdentifier(n) && n.text === "ReportInputsSchema") schemaUse.push(`${at(n)} ReportInputsSchema`);
          if (ts.isBinaryExpression(n) && CMP_OPS.has(n.operatorToken.kind)) {
            const shown = `${at(n)} «${oneLine(nodeText(bl, n))}»`;
            // числовой литерал в сравнении — своя граница (кроме сравнений с .length)
            const [l, r] = [numLit(n.left), numLit(n.right)];
            if ((l != null && !isLen(n.right)) || (r != null && !isLen(n.left))) {
              lits.push(shown);
              walk(n, (x) => { if (ts.isNumericLiteral(x)) litPos.add(x.getStart(bl.sf)); });
            }
            const [kl, kr] = [refs.kind(n.left), refs.kind(n.right)];
            const b = kr === "min" || kr === "max" ? kr : kl === "min" || kl === "max" ? kl : null;
            if (b) {
              const op = b === kr ? n.operatorToken.kind : (FLIP[n.operatorToken.kind] ?? n.operatorToken.kind);
              const x = squash(nodeText(bl, b === kr ? n.left : n.right));
              if (BOUND_OPS[b].includes(op)) okCmp[b].set(x, shown);
              else badCmp.push(`${shown} (${b}: граница ${op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken ? "как точка" : "исключительно"}, а в схеме — включительно)`);
            }
          }
          // литерал, равный границе константы, где угодно в AskPrice (Math.min/max, атрибуты min/max поля, свои константы)
          if (ts.isNumericLiteral(n) && boundVals.includes(Number(n.text)) && !litPos.has(n.getStart(bl.sf)))
            lits.push(`${at(n)} литерал ${n.text} (= границе ${PRICE_CONST})`);
        });
      }
      const askLine = lineAt(bl.sf, ask.node.getStart(bl.sf));
      const both = [...okCmp.min.keys()].filter((x) => okCmp.max.has(x));
      if (!refs.bindings.length) problems.push(`blocks.tsx: CONFIG не импортирован значением из ${PRICE_CONFIG_SPEC} — проверке цены не из чего брать границы (И4, §4.2)`);
      if (!both.length)
        problems.push(`AskPrice (blocks.tsx:${askLine}): цена не проверяется через ${PRICE_CONST} из ${PRICE_CONFIG_SPEC} — нужно сравнение одного значения с .min (>=) и .max (<=) константы; ` +
          `найдено: min ${okCmp.min.size ? [...okCmp.min.values()].join(", ") : "—"}, max ${okCmp.max.size ? [...okCmp.max.values()].join(", ") : "—"} (И4, §4.2)`);
      if (badCmp.length) problems.push(`AskPrice: ${badCmp.join(", ")}`);
      if (lits.length) problems.push(`AskPrice: границы цены числовыми литералами — ${uniq(lits).join(", ")} (границы — из ${PRICE_CONST}${cv.ok ? `: min ${cv.min}, max ${cv.max}` : ""})`);
      if (schemaUse.length) problems.push(`AskPrice: проверка через схему, а не через константу — ${uniq(schemaUse).join(", ")} (значение схемы тянет zod в клиентский бандл)`);
      if (both.length && !badCmp.length && !lits.length && !schemaUse.length)
        notes.push(`AskPrice: ${PRICE_CONST} из ${PRICE_CONFIG_SPEC} (${refs.bindings.join(", ")}), ${okCmp.min.get(both[0])} и ${okCmp.max.get(both[0])}${cv.ok ? `, константа min ${cv.min} / max ${cv.max} (${CONFIG_REL}:${cv.line})` : ""}, литералов границ нет`);
      const cp = contractPriceProblems(root);
      problems.push(...cp.problems);
      if (cp.note) notes.push(cp.note);
    }
  }

  /* (6) packages/blocks/src: из @so/engine/contract — только типы. Значение схемы, которое клиентский код использует, тянет zod и
   *     contract.ts в клиентские бандлы даже при "sideEffects": false; импорт схемы в @so/present/entry (ради initialOf) клиент не
   *     использует, и он выпадает только благодаря "sideEffects": false в @so/engine — это держит часть (7) */
  const blDir = path.join(root, "packages/blocks/src");
  if (isDir(blDir)) {
    const vals: string[] = [];
    let typeImports = 0;
    for (const f of scriptFiles(blDir)) {
      const p = f.endsWith("blocks.tsx") && bl ? bl : parseSource(f);
      for (const r of importsOf(p.sf)) {
        if (r.spec !== CONTRACT_SPEC) continue;
        const valueNames = r.names.filter((x) => !x.type).map((x) => x.name);
        // только типы: `import type …`, `import("…").T` в типе, или все имена с `type`; голый `import "…"` — значение (модуль исполняется)
        if (r.typeOnly || r.via === "import(тип)" || (r.whole == null && r.names.length > 0 && !valueNames.length)) { typeImports++; continue; }
        vals.push(`${relOf(root, f)}:${r.line} ${r.via}${valueNames.length ? ` { ${valueNames.join(", ")} }` : r.whole ? ` (${r.whole})` : " (без имён — модуль исполняется)"}`);
      }
    }
    if (vals.length) problems.push(`packages/blocks/src: значения из ${CONTRACT_SPEC} — ${vals.join("; ")} (клиентскому коду — только типы, иначе zod и contract.ts в бандле)`);
    else notes.push(`из ${CONTRACT_SPEC} в packages/blocks/src только типы (${typeImports} импортов)`);
  }

  /* (7) "sideEffects": false в packages/engine/package.json (ревью 20.10, F1/R2-1). @so/present/entry импортирует ReportInputsSchema
   *     значением ради initialOf, а entry импортируют клиентские модули (CheckClient, ChatApp, Thread, ToolUIs, а blocks.tsx — через
   *     @so/present/report → ./entry). Сборщик выбрасывает неиспользуемый импорт схемы, только если модули @so/engine помечены
   *     без побочных эффектов; без флага zod и contract.ts возвращаются в клиент (+59,8 КБ на /, /check, /chat; static client.js
   *     236 317 → 301 733 Б) */
  {
    const rel = "packages/engine/package.json";
    const abs = path.join(root, rel);
    let se: unknown = undefined, err: string | null = null;
    try { se = (JSON.parse(fs.readFileSync(abs, "utf8")) as { sideEffects?: unknown }).sideEffects; }
    catch (e) { err = e instanceof Error ? e.message : String(e); }
    if (err) problems.push(`${rel} не прочитан: ${err}`);
    else if (se !== false)
      problems.push(`${rel}: "sideEffects" ${se === undefined ? "нет" : `= ${JSON.stringify(se)}`}, нужен false — без флага @so/present/entry (initialOf) тянет zod и contract.ts в клиентский бандл`);
    else notes.push(`${rel}: "sideEffects": false (иначе @so/present/entry тянет zod и contract.ts в клиент)`);
  }

  /* (4) branches.tsx: нет функций склонения (% 10 / % 100, plural) */
  const br = parsed["branches.tsx"];
  if (br) {
    const decls = topDecls(br.sf);
    const decl: string[] = [];
    walk(br.sf, (n) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PercentToken && ts.isNumericLiteral(n.right) && ["10", "100"].includes(n.right.text)) {
        const o = ownerAt(decls, br.sf, n.getStart(br.sf));
        decl.push(`${o ? o.name : "?"} (:${lineAt(br.sf, n.getStart(br.sf))} «% ${n.right.text}»)`);
      }
    });
    for (const r of refsTo(br.sf, "plural")) decl.push(`plural (:${lineAt(br.sf, r.getStart(br.sf))})`);
    if (decl.length) problems.push(`branches.tsx: склонение в React — ${uniq(decl).slice(0, 4).join(", ")} (тексты веток со склонением — в VM через plural из format.ts)`);
  }
  return { problems, notes };
}
/** `a . b ["c"]` → `a.b.c` */
const normAccess = (s: string) => squash(s).replace(/\[["'`]([A-Za-z_$][\w$]*)["'`]\]/g, ".$1").replace(/\?\./g, ".");

function runTG7(root: string): Verdict {
  const r = analyzeBlocks(root);
  const want = "ожид.: в packages/blocks/src/{blocks,branches,ReportView,ui}.tsx нет кириллицы в литералах и JSX-тексте (тексты — из VM и WEB), " +
    "в ui.tsx нет pct2/pctMax/cap1/scoreTone/liquidityTone, fmt/fmtMax/CONFIG только в InputsPanel и AskPrice, в branches.tsx нет склонения, " +
    `AskPrice проверяет цену через ${PRICE_CONST} из ${PRICE_CONFIG_SPEC} (n >= min, n <= max — включительно, как схема), без числовых литералов границ; ` +
    `offer_price_pct в contract.ts — ровно z.number().min(${PRICE_CONST}.min).max(${PRICE_CONST}.max) (из прочего — только .nullable/.optional/.finite/.describe); из ${CONTRACT_SPEC} в packages/blocks/src только типы; ` +
    `в packages/engine/package.json "sideEffects": false`;
  return r.problems.length ? fail(`${r.problems.join(" | ")} | ${want}`) : pass(r.notes.join("; "));
}

/* ═══════════════════════════ TG.15 — нейтральные слова ═══════════════════════════ */

/** Границы слова для кириллицы (в JS `\b` с кириллицей не работает) — §6 TG.15 */
const PROMPT_WORDS = /(?<![а-яё])(?:справа|слева|ниже)(?![а-яё])/giu;
const COPY_WORDS = /(?<![а-яё])(?:справа|ниже)(?![а-яё])|обновите\s+страницу/giu;

/** Значение строковой константы из литерала (если импорт модуля не удался): строки, шаблоны (подстановки — «${…}»), `+` */
function constValue(p: Parsed, name: string): string | null {
  const ev = (e: ts.Expression): string | null => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => "${…}" + s.literal.text).join("");
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return ev(e.expression);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) { const a = ev(e.left), b = ev(e.right); return a != null && b != null ? a + b : null; }
    return null;
  };
  let out: string | null = null;
  walk(p.sf, (n) => { if (out == null && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) out = ev(n.initializer); });
  return out;
}
/** Совпадения слов в тексте: «слово» ×N — контексты */
function wordHits(text: string, re: RegExp): { word: string; ctx: string; i: number }[] {
  return [...text.matchAll(re)].map((m) => ({ word: m[0].toLowerCase().replace(/\s+/g, " "), ctx: around(text, m.index, m[0].length), i: m.index }));
}

async function runTG15(root: string): Promise<Verdict> {
  const parts: string[] = [];
  let ok = true;
  /* SYSTEM_PROMPT */
  const promptRel = "apps/web/lib/prompt.ts";
  const promptAbs = path.join(root, promptRel);
  if (!isFile(promptAbs)) { ok = false; parts.push(`нет ${promptRel}`); }
  else {
    const p = parseSource(promptAbs);
    const imp = await tryImport<{ SYSTEM_PROMPT?: unknown }>(promptAbs, 4, { need: ["SYSTEM_PROMPT"] });
    let value: string | null = null;
    let source = "";
    if (imp.ok && typeof imp.mod.SYSTEM_PROMPT === "string") { value = imp.mod.SYSTEM_PROMPT; source = "импорт модуля"; }
    else { value = constValue(p, "SYSTEM_PROMPT"); source = `литерал (импорт: ${imp.ok ? "SYSTEM_PROMPT не строка" : imp.detail})`; }
    if (value == null) { ok = false; parts.push(`SYSTEM_PROMPT в ${promptRel} не найден (${source})`); }
    else {
      const hits = wordHits(value, PROMPT_WORDS);
      if (hits.length) {
        ok = false;
        // те же слова в исходнике — с номерами строк
        const src = wordHits(p.code, PROMPT_WORDS).map((h) => `prompt.ts:${lineAt(p.sf, h.i)} «${h.ctx}»`);
        const counts = uniq(hits.map((h) => h.word)).map((w) => `«${w}» ×${hits.filter((h) => h.word === w).length}`).join(", ");
        parts.push(`SYSTEM_PROMPT (${source}): ${counts} — ${list(src.length ? src : hits.map((h) => `«${h.ctx}»`), 4)}`);
      } else parts.push(`SYSTEM_PROMPT (${source}, ${value.length} симв.): «справа», «слева», «ниже» нет`);
    }
  }
  /* telegram-тексты @so/present/copy */
  const copy = await tryImport<CopyMod>(path.join(root, PRESENT.copy.rel), PRESENT.copy.step, { need: PRESENT.copy.need });
  if (!copy.ok) { ok = false; parts.push(`copy: ${copy.detail}`); }
  else {
    const c = copy.mod;
    const texts: { where: string; text: string }[] = [];
    const bad: string[] = [];
    const take = (where: string, f: () => unknown) => {
      try { const v = f(); if (typeof v === "string") texts.push({ where, text: v }); else bad.push(`${where} не строка (${typeof v})`); }
      catch (e) { bad.push(`${where} бросил: ${errText(e)}`); }
    };
    take("WAIT_REPORT", () => c.WAIT_REPORT);
    take("WAIT_TERM", () => c.WAIT_TERM);
    take("DISCLAIMER", () => c.DISCLAIMER);
    take(`limitText("telegram", 20)`, () => c.limitText("telegram", 20));
    take(`budgetExhaustedText("telegram")`, () => c.budgetExhaustedText("telegram"));
    const B = (c.BOT ?? {}) as unknown as Record<string, unknown>;
    if (!Object.keys(B).length) bad.push("BOT пуст");
    for (const [k, v] of Object.entries(B)) {
      if (typeof v === "function") {
        const arg = k === "notAllowed" ? "A1b2C3" : 2;
        take(`BOT.${k}(${JSON.stringify(arg)})`, () => (v as (a: unknown) => unknown)(arg));
      } else take(`BOT.${k}`, () => v);
    }
    const hits = texts.flatMap((t) => wordHits(t.text, COPY_WORDS).map((h) => `${t.where}: «${h.word}» в «${h.ctx}»`));
    if (bad.length) { ok = false; parts.push(`copy: ${list(bad, 4)}`); }
    if (hits.length) { ok = false; parts.push(`copy: ${list(hits, 4)}`); }
    if (!bad.length && !hits.length) parts.push(`copy: ${texts.length} telegram-текстов (WAIT_*, DISCLAIMER, limitText/budgetExhaustedText("telegram"), BOT.*) без «справа», «ниже», «обновите страницу»`);
  }
  const want = "ожид.: в SYSTEM_PROMPT нет «справа», «слева», «ниже» (prompt.ts:11 → «в блоке «Доходность»», «в блоке Truth Score»; :20 правило 10 → «меньше»); в telegram-текстах copy нет «справа», «ниже», «обновите страницу»";
  return ok ? pass(parts.join(" | ")) : fail(`${parts.join(" | ")} | ${want}`);
}

/* ═══════════════════════════ TG.22 — версии и одна копия ai ═══════════════════════════ */

const AI_VERSION = "7.0.133";
const GRAMMY_VERSION = "1.46.0";

/** Все каталоги пакета `name` в деревьях node_modules (корень и рабочие пространства), без перехода по симлинкам */
function packageCopies(root: string, name: string): string[] {
  const roots = [path.join(root, "node_modules")];
  for (const ws of ["apps", "packages", "tools"]) {
    const d = path.join(root, ws);
    if (isDir(d)) for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) roots.push(path.join(d, e.name, "node_modules"));
  }
  const out: string[] = [];
  const visit = (nm: string, depth: number) => {
    if (depth > 12 || !isDir(nm)) return;
    if (isFile(path.join(nm, name, "package.json"))) out.push(path.join(nm, name));
    for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith(".")) continue;
      const pkgs = e.name.startsWith("@") ? fs.readdirSync(path.join(nm, e.name), { withFileTypes: true }).filter((x) => x.isDirectory() && !x.isSymbolicLink()).map((x) => path.join(nm, e.name, x.name)) : [path.join(nm, e.name)];
      for (const p of pkgs) { const inner = path.join(p, "node_modules"); if (isDir(inner)) visit(inner, depth + 1); }
    }
  };
  for (const r of roots) visit(r, 0);
  return uniq(out).sort();
}
const versionOf = (dir: string) => { const r = readJsonFile(path.join(dir, "package.json")); return r.ok ? String(r.v.version ?? "?") : `? (${r.err})`; };

function runTG22(root: string): Verdict {
  const problems: string[] = [];
  const notes: string[] = [];
  const webPj = readJsonFile(path.join(root, "apps/web/package.json"));
  const webAi = webPj.ok ? String((webPj.v.dependencies as Record<string, string> | undefined)?.ai ?? "") : "";
  if (webAi !== AI_VERSION) problems.push(`apps/web: ai «${webAi || "нет"}», план фиксирует ${AI_VERSION}`);

  /* apps/bot/package.json */
  const botPjAbs = path.join(root, "apps/bot/package.json");
  if (!isFile(botPjAbs)) problems.push(`нет apps/bot/package.json${isDir(path.join(root, "apps/bot")) ? "" : " (нет и apps/bot)"}; ожидаемо до шага 1а (@so/bot: точные ai ${AI_VERSION} и grammy ${GRAMMY_VERSION}, без @ai-sdk/* и @openrouter/*)`);
  else {
    const pj = readJsonFile(botPjAbs);
    if (!pj.ok) problems.push(`apps/bot/package.json не читается: ${pj.err}`);
    else {
      const sec = (k: string) => (pj.v[k] && typeof pj.v[k] === "object" ? (pj.v[k] as Record<string, string>) : {});
      const deps = sec("dependencies");
      const all = { ...sec("devDependencies"), ...sec("optionalDependencies"), ...sec("peerDependencies"), ...deps };
      if (deps.ai !== AI_VERSION || deps.ai !== webAi) problems.push(`apps/bot dependencies.ai = «${deps.ai ?? "нет"}», нужно точно «${AI_VERSION}» (как в apps/web: «${webAi}»)`);
      if (deps.grammy !== GRAMMY_VERSION) problems.push(`apps/bot dependencies.grammy = «${deps.grammy ?? "нет"}», нужно точно «${GRAMMY_VERSION}»`);
      const prov = Object.keys(all).filter((k) => k.startsWith("@ai-sdk/") || k.startsWith("@openrouter/"));
      if (prov.length) problems.push(`в зависимостях apps/bot есть провайдеры LLM: ${prov.join(", ")}`);
      if (!problems.length) notes.push(`apps/bot: ai ${deps.ai}, grammy ${deps.grammy}, без @ai-sdk/* и @openrouter/*`);
      // установленная grammy (npm install шага 1а)
      const g = [path.join(root, "apps/bot/node_modules/grammy"), path.join(root, "node_modules/grammy")].find((d) => isFile(path.join(d, "package.json")));
      if (!g) problems.push("grammy не установлена (нет node_modules/grammy — npm install шага 1а)");
      else if (versionOf(g) !== GRAMMY_VERSION) problems.push(`установлена grammy ${versionOf(g)} (${relOf(root, g)}), нужна ${GRAMMY_VERSION}`);
    }
  }

  /* node_modules/ai — одна копия */
  const copies = packageCopies(root, "ai");
  const main = path.join(root, "node_modules/ai");
  const shown = copies.map((d) => `${relOf(root, d)}@${versionOf(d)}`);
  if (!copies.includes(main)) problems.push(`нет node_modules/ai${copies.length ? ` (есть: ${shown.join(", ")})` : ""}`);
  else if (versionOf(main) !== AI_VERSION) problems.push(`node_modules/ai@${versionOf(main)}, нужна ${AI_VERSION}`);
  if (copies.length > 1) problems.push(`ai установлена в ${copies.length} копиях: ${shown.join(", ")} — нужна одна (иначе типы UIMessage и сборка ответа у бота и сервера разные)`);
  /* то же по package-lock.json */
  const lockAbs = path.join(root, "package-lock.json");
  let lockNote = "package-lock.json нет";
  if (isFile(lockAbs)) {
    const lock = readJsonFile(lockAbs);
    if (!lock.ok) problems.push(`package-lock.json не читается: ${lock.err}`);
    else {
      const pk = (lock.v.packages ?? {}) as Record<string, { version?: string }>;
      const keys = Object.keys(pk).filter((k) => /(?:^|\/)node_modules\/ai$/.test(k));
      lockNote = `в lock: ${keys.map((k) => `${k}@${pk[k]?.version ?? "?"}`).join(", ") || "нет записи ai"}`;
      if (keys.length !== 1 || keys[0] !== "node_modules/ai") problems.push(`package-lock.json: записей ai ${keys.length} — ${keys.join(", ") || "нет"} (нужна одна: node_modules/ai)`);
      else if (pk[keys[0]]?.version !== AI_VERSION) problems.push(`package-lock.json: node_modules/ai@${pk[keys[0]]?.version}, нужна ${AI_VERSION}`);
    }
  }
  const state = `сейчас: ${shown.join(", ") || "ai не установлена"}; ${lockNote}`;
  const want = `ожид.: apps/bot/package.json с точными "ai": "${AI_VERSION}" (как apps/web) и "grammy": "${GRAMMY_VERSION}", без @ai-sdk/* и @openrouter/*; ai — одна копия (нет вложенных node_modules/**/node_modules/ai)`;
  return problems.length ? fail(`${problems.join("; ")} | ${state} | ${want}`) : pass(`${notes.join("; ")}; ai — одна копия: ${shown.join(", ")}; ${lockNote}`);
}

/* ═══════════════════════════ TG.G3 — канал не попадает в решения ═══════════════════════════ */

const G3_LIB = ["gate.ts", "jev.ts", "tools.ts", "digest.ts", "prompt.ts", "glossary.ts", "engine.ts", "session.ts", "model.ts"] as const;
/** Регэксп разрешённого импорта — дословно из плана §6 TG.G3(б) */
const G3_IMPORT_RE = /^\s*import\s*\{\s*channelOf\s*\}\s*from\s*["']@\/lib\/channel["']\s*;?\s*$/m;
const DECISION_CALLS = ["streamText", "makeTools", "runGate", "chatModel", "convertToModelMessages", "callProviderOptions"] as const;

const calleeName = (e: ts.Expression) => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null);

function runG3(root: string): Verdict {
  const problems: string[] = [];
  const notes: string[] = [];
  /* (а) lib-модули решений */
  const libHits: string[] = [];
  for (const f of G3_LIB) {
    const abs = path.join(root, "apps/web/lib", f);
    if (!isFile(abs)) { problems.push(`(а) нет apps/web/lib/${f}`); continue; }
    const p = parseSource(abs);
    for (const m of p.code.matchAll(/channel|telegram|x-so-bot-key/gi)) libHits.push(`${f}:${lineAt(p.sf, m.index)} «${m[0]}»: ${cut(oneLine(lineTextAt(p.code, m.index)), 60)}`);
  }
  if (libHits.length) problems.push(`(а) канал в модулях решений: ${list(libHits, 5)}`);
  else notes.push(`(а) ${G3_LIB.length} модулей apps/web/lib (${G3_LIB.map((f) => f.replace(".ts", "")).join(", ")}) без channel/telegram/x-so-channel/x-so-bot-key (вне комментариев)`);

  /* (б) route.ts: вырезать разрешённые фрагменты, в остатке канала нет */
  const routeRel = "apps/web/app/api/chat/route.ts";
  const routeAbs = path.join(root, routeRel);
  if (!isFile(routeAbs)) problems.push(`(б) нет ${routeRel}`);
  else {
    const p = parseSource(routeAbs);
    const rm: [number, number][] = [];
    const logFrag: [number, number][] = [];
    const cnt = { import: 0, ch: 0, if403: 0, log: 0, limit: 0, budget: 0 };
    const im = p.code.match(G3_IMPORT_RE);
    if (im && im.index !== undefined) { rm.push([im.index, im.index + im[0].length]); cnt.import = 1; }
    let chArg: ts.Expression | null = null;
    walk(p.sf, (n) => {
      // const ch = channelOf(req, <id>) — один раз; выражение <id> остаётся в остатке
      if (!cnt.ch && ts.isVariableStatement(n) && (n.declarationList.flags & ts.NodeFlags.Const) && n.declarationList.declarations.length === 1) {
        const d = n.declarationList.declarations[0];
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && d.name.text === "ch" && init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "channelOf"
          && init.arguments.length === 2 && ts.isIdentifier(init.arguments[0]) && init.arguments[0].text === "req") {
          chArg = init.arguments[1];
          rm.push([n.getStart(p.sf), chArg.getStart(p.sf)], [chArg.end, n.end]);
          cnt.ch = 1;
        }
      }
      // if (!ch.ok) return new Response(null, { status: 403 }) — один раз
      if (!cnt.if403 && ts.isIfStatement(n) && !n.elseStatement && squash(nodeText(p, n.expression)) === "!ch.ok") {
        const t = n.thenStatement;
        const ret = ts.isReturnStatement(t) ? t : ts.isBlock(t) && t.statements.length === 1 && ts.isReturnStatement(t.statements[0]) ? t.statements[0] : null;
        if (ret?.expression && squash(nodeText(p, ret.expression)).replace(/,\}/g, "}") === "newResponse(null,{status:403})") { rm.push([n.getStart(p.sf), n.end]); cnt.if403 = 1; }
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const name = n.expression.text;
        // channel: ch.channel в объектах-аргументах log({...})
        if (name === "log") for (const a of n.arguments) if (ts.isObjectLiteralExpression(a)) for (const pr of a.properties) {
          if (ts.isPropertyAssignment(pr) && (ts.isIdentifier(pr.name) || ts.isStringLiteral(pr.name)) && pr.name.text === "channel" && squash(nodeText(p, pr.initializer)) === "ch.channel") {
            rm.push([pr.getStart(p.sf), pr.end]); logFrag.push([pr.getStart(p.sf), pr.end]); cnt.log++;
          }
        }
        // limitText(ch.channel, MESSAGE_LIMIT), budgetExhaustedText(ch.channel)
        const args = n.arguments.map((a) => squash(nodeText(p, a)));
        if (name === "limitText" && args.length === 2 && args[0] === "ch.channel" && args[1] === "MESSAGE_LIMIT") { rm.push([n.getStart(p.sf), n.end]); cnt.limit++; }
        if (name === "budgetExhaustedText" && args.length === 1 && args[0] === "ch.channel") { rm.push([n.getStart(p.sf), n.end]); cnt.budget++; }
      }
    });
    const rest = blank(p.code, rm);
    const restHits: string[] = [];
    for (const [re, what] of [[/\bch\b/g, "ch"], [/channel/gi, "channel"], [/telegram/gi, "telegram"], [/tg_/gi, "tg_"], [/x-so-bot-key/gi, "x-so-bot-key"]] as const)
      for (const m of rest.matchAll(re)) restHits.push(`:${lineAt(p.sf, m.index)} ${what} — ${cut(oneLine(lineTextAt(rest, m.index)), 70)}`);
    // req.headers.get — только "x-so-chat" (любой объект .headers.get)
    const hdr: string[] = [];
    let hdrOk = 0;
    walk(p.sf, (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "get"
        && ts.isPropertyAccessExpression(n.expression.expression) && n.expression.expression.name.text === "headers") {
        const a = n.arguments[0];
        if (n.arguments.length === 1 && a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && a.text === "x-so-chat") hdrOk++;
        else hdr.push(`:${lineAt(p.sf, n.getStart(p.sf))} ${cut(oneLine(nodeText(p, n)), 60)}`);
      }
    });
    const frag = `вырезано: импорт channelOf ${cnt.import}, const ch = channelOf(req, …) ${cnt.ch}, if (!ch.ok) return 403 ${cnt.if403}, channel: ch.channel в log ${cnt.log}, limitText(ch.channel, MESSAGE_LIMIT) ${cnt.limit}, budgetExhaustedText(ch.channel) ${cnt.budget}`;
    if (restHits.length) problems.push(`(б) route.ts: канал вне разрешённых фрагментов §4.3 — ${list(uniq(restHits), 5)} (${frag})`);
    if (hdr.length) problems.push(`(б) route.ts: headers.get не с «x-so-chat» — ${hdr.join("; ")}`);
    if (!restHits.length && !hdr.length) notes.push(`(б) route.ts: ${frag}; в остатке нет ch/channel/telegram/tg_/x-so-channel/x-so-bot-key; headers.get — ${hdrOk}, все с «x-so-chat»`);

    /* (в) аргументы вызовов решений: без ch/channel (разрешён только channel: ch.channel внутри log({...}) — log шага llm лежит в onStepFinish streamText) */
    const viaLog = blank(p.code, logFrag);
    const calls: Record<string, number> = {};
    const argHits: string[] = [];
    walk(p.sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const name = calleeName(n.expression);
      if (!name || !(DECISION_CALLS as readonly string[]).includes(name)) return;
      calls[name] = (calls[name] ?? 0) + 1;
      if (!n.arguments.length) return;
      const s = n.arguments[0].getStart(p.sf), e = n.arguments[n.arguments.length - 1].end;
      const t = viaLog.slice(s, e);
      for (const m of t.matchAll(/\bch\b|channel/gi)) argHits.push(`:${lineAt(p.sf, s + m.index)} ${name}(… ${m[0]} …) — ${cut(oneLine(lineTextAt(viaLog, s + m.index)), 60)}`);
    });
    const callsTxt = DECISION_CALLS.map((c) => `${c} ${calls[c] ?? 0}`).join(", ");
    if (argHits.length) problems.push(`(в) канал в аргументах вызовов решений: ${list(uniq(argHits), 5)}`);
    else if (!calls.streamText || !calls.runGate) problems.push(`(в) в route.ts не найдены вызовы streamText/runGate (${callsTxt}) — проверка аргументов ничего не различает`);
    else notes.push(`(в) аргументы вызовов решений (${callsTxt}) без ch/channel`);
  }
  const want = "ожид.: канал не попадает в решения — ни в модули gate/jev/tools/digest/prompt/glossary/engine/session/model, ни в route.ts вне разрешённых фрагментов §4.3, ни в аргументы streamText/makeTools/runGate/chatModel/convertToModelMessages/callProviderOptions";
  return problems.length ? fail(`${problems.join(" | ")} | ${want}`) : pass(notes.join("; "));
}

/* ═══════════════════════════ проверки ═══════════════════════════ */

/** Проверки группы над корнем репозитория root (по умолчанию — этот репозиторий) */
export function makeStaticChecks(root: string = REPO_ROOT): Check[] {
  return [
    {
      id: "TG.1", wp: "TG", kind: "static",
      title: "И1: граф импортов apps/bot/src и @so/present без решений, ключей LLM/Jev и имён пользователя",
      run: () => runTG1(root),
    },
    {
      id: "TG.2", wp: "TG", kind: "static",
      title: "В литералах apps/bot/src нет кириллицы: все тексты бота — из @so/present/copy",
      run: () => runTG2(root),
    },
    {
      id: "TG.7", wp: "TG", kind: "static",
      title: "И3: React-блоки без своих текстов и форматирования чисел; AskPrice проверяет цену константой пределов из @so/engine/config (той же, что схема: offer_price_pct — ровно z.number().min/.max от неё); \"sideEffects\": false в @so/engine (zod и contract.ts не в клиенте)",
      run: () => runTG7(root),
    },
    {
      id: "TG.15", wp: "TG", kind: "static",
      title: "Нейтральные слова: в SYSTEM_PROMPT нет «справа/слева/ниже», в telegram-текстах copy — «справа/ниже/обновите страницу»",
      run: () => runTG15(root),
    },
    {
      id: "TG.22", wp: "TG", kind: "static",
      title: "Версии бота: точные ai 7.0.133 и grammy 1.46.0, одна копия ai, без @ai-sdk/* и @openrouter/*",
      run: () => runTG22(root),
    },
    {
      id: "TG.G3", wp: "TG", kind: "static", guard: true,
      title: "И2: канал не попадает в решения (lib-модули, route.ts вне разрешённых фрагментов, аргументы вызовов модели)",
      run: () => runG3(root),
    },
  ];
}

export const checks: Check[] = makeStaticChecks();
