/**
 * WP-S (apps/web) — защита открытого стенда. Источники: docs/AUDIT_PLAN_2026-10-09.md (раздел WP-S + поправки
 * оркестратора раунда 3), docs/AUDIT_2026-10-09.md (R2-18, рекомендация 9). Не-guard проверки утверждают ЖЕЛАЕМОЕ
 * поведение (после правки) — до правки RED. S.3 — guard: инварианты, которые держатся уже сейчас.
 *
 * Все три — kind static: /api/chat и Caddy нельзя вызвать без сервера, а вызов маршрута тянет Jev/модель (платный
 * бюджет). Контракт static-проверки здесь: (1) комментарии сняты (TS: строчные `//` и блочные, с учётом строковых литералов;
 * Caddyfile и shell: `#` в начале токена); (2) смотрятся ВСЕ совпадения, а не первое; (3) принимаются эквивалентные
 * формы (любые имена констант, тернарник/env-override, матчер /api/chat или /api/*, ответ через helper-функцию);
 * (4) в detail перечислено, что распознано и что нет. Анализаторы — чистые функции над текстом; перед реальной
 * проверкой они прогоняются на встроенных контрольных образцах (ожидаемые OK / не-OK) — расхождение означает дефект
 * харнеса, бросается исключение → статус ERROR (а не ложный RED/GREEN).
 *
 * Что static-проверка НЕ распознаёт (такая правка останется RED — см. detail и limitations отчёта):
 *  S.1 — лимитер внутри route.ts/lib (план называет Caddy rate_limit или middleware.ts), внешний WAF/CDN, Caddy в
 *        JSON-конфиге, Caddyfile вне deploy/ или не записываемый в /etc/caddy/Caddyfile (путь через переменную),
 *        middleware без явной числовой константы лимита или без переменной с адресом клиента.
 *  S.2 — лимит в zod-схеме (.max/.refine), в middleware или lib-валидаторе, двухшаговая форма `const over = …; if (over)`,
 *        статус через константу (`status: HTTP_TOO_LARGE`), арифметика в пределе (`2 * 1000`), обрезка истории
 *        не через slice/splice/shift.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, readSrc, REPO_ROOT, type Check, type Verdict } from "../lib";

const WEB = "apps/web";
const ROUTE = `${WEB}/app/api/chat/route.ts`;
const SESSION = `${WEB}/lib/session.ts`;
const DEPLOY = "deploy";
const CADDY_TARGET = "/etc/caddy/Caddyfile";
/** Пределы из плана (WP-S, «Изменение»): реплика ≤ 2 000 символов, история ≤ 40 сообщений / ≤ 20 000 символов */
const PLAN = { reply: 2000, count: 40, chars: 20000 } as const;
/** Замороженный момент для динамической части S.3 (полдень UTC = 15:00 МСК, далеко от полуночи) */
const FIXED_ISO = "2026-10-09T12:00:00Z";
const FIXED_MSK_DAY = "2026-10-09";

const exists = (rel: string) => fs.existsSync(path.join(REPO_ROOT, rel));
const lineOf = (src: string, idx: number) => (idx < 0 ? -1 : src.slice(0, idx).split("\n").length);
const squash = (s: string, n = 100) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const NUM = String.raw`\d[\d_]*(?:\.\d+)?`;
const toNum = (s: string) => Number(s.replace(/_/g, ""));
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const selfTest = (name: string, cond: boolean, info: string) => {
  if (!cond) throw new Error(`самопроверка анализатора WP-S «${name}» не прошла (дефект харнеса): ${info}`);
};

/* ───────────────────────────── снятие комментариев ───────────────────────────── */

/** TypeScript: `//…` и блочные комментарии → пробелы (переносы сохраняются → номера строк совпадают с исходником).
 *  Строковые литералы '…' "…" `…` не трогаются; `\x` вне строк пропускается парой (экранированные `/` в regex-литералах).
 *  Не распознаёт regex-литерал с неэкранированным `//` внутри класса символов — в route.ts таких нет. */
function stripTs(src: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; ) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\" && i + 1 < src.length) { out += ch + src[i + 1]; i += 2; continue; }
      if (ch === quote) quote = null;
      out += ch; i++; continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; i++; continue; }
    if (ch === "\\" && i + 1 < src.length) { out += ch + src[i + 1]; i += 2; continue; }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      out += " ".repeat(end - i); i = end; continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? src.length : e + 2;
      out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; continue;
    }
    out += ch; i++;
  }
  return out;
}
/** Caddyfile / shell: `#` в начале токена (начало строки или после пробела) до конца строки → пробелы.
 *  `${X#pat}` и `a#b` не задеты (нет пробела перед `#`). */
const stripHash = (s: string) => s.split("\n").map((l) => l.replace(/(^|\s)#.*$/, (m) => " ".repeat(m.length))).join("\n");

/* ───────────────────────────── разбор TypeScript ───────────────────────────── */

/** Индекс закрывающей скобки для открывающей в src[open] ('(' | '{' | '['); строки пропускаются */
function balanced(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const o = src[open];
  const c = pairs[o];
  if (!c) return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

/** Блок `if (…) {…}` / `while (…) {…}` (или одиночный оператор до `;`), в УСЛОВИИ которого стоит индекс inside */
function condBlockAround(src: string, inside: number): { cond: string; block: string; start: number } | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of src.slice(0, inside).matchAll(/\b(?:if|while)\s*\(/g)) last = m as unknown as RegExpExecArray;
  if (!last) return undefined;
  const open = last.index + last[0].length - 1;
  const close = balanced(src, open);
  if (close < inside) return undefined;
  const ws = /^\s*/.exec(src.slice(close + 1))![0].length;
  const bOpen = close + 1 + ws;
  if (src[bOpen] === "{") {
    const bClose = balanced(src, bOpen);
    if (bClose < 0) return undefined;
    return { cond: src.slice(open + 1, close), block: src.slice(bOpen, bClose + 1), start: last.index };
  }
  const semi = src.indexOf(";", close);
  return { cond: src.slice(open + 1, close), block: src.slice(close + 1, semi < 0 ? undefined : semi + 1), start: last.index };
}

/** Имена модулей из `import … from "@/lib/<name>"` (только существующие файлы) */
const libNames = (src: string) =>
  uniq([...src.matchAll(/from\s*"@\/lib\/([\w-]+)"/g)].map((m) => m[1])).filter((n) => exists(`${WEB}/lib/${n}.ts`));
const libSrc = (name: string) => readSrc(`${WEB}/lib/${name}.ts`);
/** Транзитивное замыкание lib-модулей по `@/lib/*`-импортам на глубину depth */
function libClosure(names: string[], depth: number): string[] {
  const seen = new Set(names);
  let frontier = [...seen];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const n of frontier) for (const l of libNames(libSrc(n))) if (!seen.has(l)) { seen.add(l); next.push(l); }
    frontier = next;
  }
  return [...seen];
}

/** Единственное число в выражении-объявлении: убираются `process.env.X` и radix `, 10)` → остаётся ровно один литерал
 *  (`N`, `Number(env ?? N)`, `env ? Number(env) : N`, `Number(env) || N`, `parseInt(env ?? "N", 10)`, `Number("N")`) */
function numOf(expr: string): number | undefined {
  const cleaned = expr.replace(/process\.env\.\w+/g, "").replace(/,\s*10\s*\)/g, ")");
  const lits = uniq([...cleaned.matchAll(new RegExp(`(?<![\\w.])${NUM}(?![\\w.])`, "g"))].map((m) => toNum(m[0])));
  return lits.length === 1 ? lits[0] : undefined;
}
/** Литерал или константа `NAME = <expr>` / `NAME: <expr>` (любое имя; `a.b.NAME` → NAME) в области scope */
function resolveLimit(id: string, scope: string): { value?: number; decl?: string } {
  if (new RegExp(`^${NUM}$`).test(id)) return { value: toNum(id) };
  const name = id.split(".").pop() ?? "";
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return {};
  const re = new RegExp(String.raw`(?<![\w$.])(?:(?:export\s+)?(?:const|let|var)\s+)?${reEsc(name)}\s*(?::\s*number\s*)?[:=](?![=>])\s*([^;\n]+)`, "g");
  let decl: string | undefined;
  for (const m of scope.matchAll(re)) {
    decl ??= squash(m[0], 90);
    const v = numOf(m[1]);
    if (v !== undefined) return { value: v, decl: squash(m[0], 90) };
  }
  return { decl };
}
/** Объявление `function NAME(` / `const NAME =` (верхний уровень) → текст до следующей строки без отступа → код 400/413 */
function helperStatus(name: string, scope: string): string | undefined {
  const m = new RegExp(String.raw`(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?(?:function\s+${reEsc(name)}\s*\(|(?:const|let|var)\s+${reEsc(name)}\s*(?::[^=\n]+)?=)`).exec(scope);
  if (!m) return undefined;
  const rest = scope.slice(m.index + m[0].length);
  const end = /\n(?=\S)/.exec(rest)?.index;
  return /\b(400|413)\b/.exec(rest.slice(0, end))?.[1];
}

/** Рекурсивный список файлов под deploy/ (репо-относительные пути), basename по предикату */
function deployFiles(pred: (base: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(r); }
      else if (pred(e.name)) out.push(r);
    }
  };
  walk(DEPLOY);
  return out.sort();
}

/* ───────────────────────────── S.1: Caddyfile ───────────────────────────── */

interface Report { ok: boolean; note: string }
interface CNode { tokens: string[]; line: number; children: CNode[]; parent: CNode | null }

/** Дерево Caddyfile (комментарии уже сняты): строка с последним токеном `{` открывает блок, строка `}` закрывает.
 *  Плейсхолдеры `{remote_host}` — один токен, скобками не считаются. */
function parseCaddy(cf: string): CNode {
  const root: CNode = { tokens: [], line: 0, children: [], parent: null };
  let cur = root;
  cf.split(/\r?\n/).forEach((raw, i) => {
    const toks = raw.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return;
    if (toks[0] === "}") { if (cur.parent) cur = cur.parent; return; }
    if (toks[toks.length - 1] === "{") {
      const node: CNode = { tokens: toks.slice(0, -1), line: i + 1, children: [], parent: cur };
      cur.children.push(node);
      cur = node;
    } else cur.children.push({ tokens: toks, line: i + 1, children: [], parent: cur });
  });
  return root;
}
const descendants = (n: CNode): CNode[] => n.children.flatMap((c) => [c, ...descendants(c)]);
const allTokens = (n: CNode): string[] => [...n.tokens, ...n.children.flatMap(allTokens)];
const isSnippet = (n: CNode) => n.tokens.length === 1 && /^\(.+\)$/.test(n.tokens[0]);

/** Копия дерева с раскрытыми `import <snippet>` (сниппеты `(name) {…}` верхнего уровня, защита от циклов);
 *  `import <файл>` и неизвестные имена — в unresolved */
function expandCaddy(root: CNode): { root: CNode; unresolved: string[] } {
  const snippets = new Map(root.children.filter(isSnippet).map((n) => [n.tokens[0].slice(1, -1), n] as const));
  const unresolved: string[] = [];
  const clone = (n: CNode, parent: CNode | null, seen: Set<string>): CNode => {
    const c: CNode = { tokens: n.tokens, line: n.line, children: [], parent };
    for (const ch of n.children) {
      if (ch.tokens[0] === "import" && ch.tokens[1]) {
        const sn = snippets.get(ch.tokens[1]);
        if (!sn || seen.has(ch.tokens[1])) { unresolved.push(ch.tokens[1]); continue; }
        for (const x of clone(sn, c, new Set([...seen, ch.tokens[1]])).children) { x.parent = c; c.children.push(x); }
        continue;
      }
      c.children.push(clone(ch, c, seen));
    }
    return c;
  };
  const out = clone(root, null, new Set());
  out.children = out.children.filter((n) => !isSnippet(n));
  return { root: out, unresolved: uniq(unresolved) };
}

/** Глоб Caddy-матчера path: `*` → любой фрагмент, остальное буквально, сравнение точное */
const globCovers = (patterns: string[], p = "/api/chat") =>
  patterns.some((g) => g === "*" || new RegExp("^" + g.split("*").map(reEsc).join(".*") + "$").test(p));
/** Покрывает ли матчер директивы путь /api/chat: нет матчера / `*` → да; литерал пути → глоб; `@name` → его `path`
 *  (глоб, принимает /api/chat, /api/chat*, /api/*) или `path_regexp`; `not path` исключает; без path → все пути */
function matcherCovers(site: CNode, m: string | undefined): [boolean, string] {
  if (!m || m === "*") return [true, "весь сайт"];
  if (!m.startsWith("@")) return [globCovers([m]), `путь «${m}»`];
  const def = descendants(site).find((d) => d.tokens[0] === m);
  if (!def) return [false, `${m} НЕ ОБЪЯВЛЕН`];
  const lines = def.children.length ? def.children.map((c) => c.tokens) : [def.tokens.slice(1)];
  const text = lines.map((t) => t.join(" ")).join("; ");
  const paths = lines.filter((t) => t[0] === "path").flatMap((t) => t.slice(1));
  const negs = lines.filter((t) => t[0] === "not" && t[1] === "path").flatMap((t) => t.slice(2));
  const rxs = lines.filter((t) => t[0] === "path_regexp").map((t) => t[t.length - 1]);
  if (negs.length && globCovers(negs)) return [false, `${m} «${text}» — not path исключает /api/chat`];
  if (!paths.length && !rxs.length) return [true, `${m} «${text}» — без path → все пути`];
  const ok = globCovers(paths) || rxs.some((r) => { try { return new RegExp(r).test("/api/chat"); } catch { return false; } });
  return [ok, `${m} «${text}»`];
}

/** Ключ зоны = адрес клиента (не заголовок, который клиент выставляет сам) */
const KEY_RE = /\{(?:http\.request\.)?(?:remote_host|remote\.host|client_ip|remote_ip|remote)\}/;
const DUR_RE = /^\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d)?$/;
interface ZoneInfo { name: string; ok: boolean; desc: string }
/** Зона caddy-ratelimit: key по адресу клиента, events — целое ≥ 1 (ненулевой лимит), window — длительность;
 *  необязательный `match { path … }` должен покрывать /api/chat */
function zoneInfo(z: CNode): ZoneInfo {
  const kv = (k: string) => z.children.find((x) => x.tokens[0] === k)?.tokens.slice(1).join(" ");
  const key = kv("key"), events = kv("events"), window = kv("window");
  const match = z.children.find((x) => x.tokens[0] === "match");
  const mPaths = match ? [match, ...descendants(match)].filter((x) => x.tokens[0] === "path").flatMap((x) => x.tokens.slice(1)) : [];
  const why: string[] = [];
  if (!key) why.push("key НЕТ"); else if (!KEY_RE.test(key)) why.push(`key ${key} — не адрес клиента`);
  if (!events) why.push("events НЕТ"); else if (!/^\d+$/.test(events) || Number(events) < 1) why.push(`events ${events} — не целое ≥ 1`);
  if (!window) why.push("window НЕТ"); else if (!DUR_RE.test(window)) why.push(`window ${window} — не длительность`);
  if (mPaths.length && !globCovers(mPaths)) why.push(`match path ${mPaths.join(" ")} без /api/chat`);
  const name = z.tokens[1] ?? "?";
  return { name, ok: !why.length, desc: `zone ${name}: ${why.length ? why.join(", ") : `key ${key}, events ${events}, window ${window}`}` };
}

/** Один Caddyfile: каждый блок с reverse_proxy →:3000 (после раскрытия сниппетов) содержит rate_limit, чей матчер
 *  покрывает /api/chat, с зоной по адресу клиента и events ≥ 1. Размещение (route{} / order) — только предупреждение. */
function analyzeCaddyfile(text: string, label: string, lineBase = 1): Report {
  const { root, unresolved } = expandCaddy(parseCaddy(stripHash(text)));
  const ln = (n: CNode) => lineBase + n.line - 1;
  const globals = root.children.filter((n) => n.tokens.length === 0);
  const sites = root.children.filter((n) => n.tokens.length > 0);
  const ordered = globals.flatMap(descendants).some((d) => d.tokens[0] === "order" && d.tokens[1] === "rate_limit");
  const proxied = sites.filter((s) => descendants(s).some((d) => d.tokens[0] === "reverse_proxy" && allTokens(d).some((t) => /(?:^|:)3000\b/.test(t))));
  if (!proxied.length) return { ok: false, note: `${label}: блоков с reverse_proxy →:3000 нет (блоки: ${sites.map((s) => s.tokens.join(" ")).join(", ") || "—"})` };
  const warn: string[] = [];
  const per = proxied.map((s) => {
    const hits = descendants(s).filter((d) => d.tokens[0] === "rate_limit");
    let ok = false;
    const descs = hits.map((h) => {
      const [pathOk, pathNote] = matcherCovers(s, h.tokens[1]);
      const zones = h.children.filter((z) => z.tokens[0] === "zone").map(zoneInfo);
      const good = pathOk && zones.some((z) => z.ok);
      ok ||= good;
      let inRoute = false;
      for (let p = h.parent; p; p = p.parent) if (p.tokens[0] === "route") inRoute = true;
      if (good && !inRoute && !ordered) warn.push(`rate_limit стр. ${ln(h)} не в route{} и без «order rate_limit …» в глобальном блоке → Caddy откажет в загрузке конфига`);
      return `rate_limit стр. ${ln(h)} (матчер ${pathNote}${pathOk ? "" : " — /api/chat НЕ покрыт"}; ${zones.map((z) => z.desc).join("; ") || "zone НЕТ"})`;
    });
    return { ok, note: `блок «${s.tokens.join(" ")}» стр. ${ln(s)}: ${descs.join(" | ") || "rate_limit НЕТ"}` };
  });
  const okN = per.filter((p) => p.ok).length;
  return {
    ok: okN === per.length,
    note: `${label}: проксирующих блоков ${per.length}, с per-IP rate_limit на /api/chat — ${okN}. ${per.map((p) => p.note).join(" · ")}` +
      (unresolved.length ? `; import не раскрыт (нет такого сниппета / импорт файла): ${unresolved.join(", ")}` : "") +
      (warn.length ? `; ВНИМАНИЕ: ${warn.join("; ")}` : ""),
  };
}

interface TextFile { rel: string; text: string }
interface CfSource { label: string; text: string; lineBase: number }
/** Какой Caddyfile реально попадает на сервер: heredoc в deploy/**\/*.sh, записываемый (tee | > | >>) в /etc/caddy/Caddyfile,
 *  и файл deploy/**\/Caddyfile* | *.caddy — только если какой-то deploy/**\/*.sh копирует его (cp|install|scp|rsync) в /etc/caddy */
function deployedCaddyfiles(shFiles: TextFile[], cfFiles: TextFile[]): { deployed: CfSource[]; ignored: string[] } {
  const deployed: CfSource[] = [];
  const HEREDOC = /^([^\n]*?)<<-?\s*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n[ \t]*\3[ \t]*$/gm;
  for (const sh of shFiles) {
    for (const m of sh.text.matchAll(HEREDOC)) {
      if (!new RegExp(String.raw`(?:\btee\b|>)[^<]*${reEsc(CADDY_TARGET)}(?![\w./-])`).test(stripHash(m[1]))) continue;
      const start = lineOf(sh.text, m.index ?? 0) + 1;
      deployed.push({ label: `${sh.rel}: heredoc <<${m[3]} → ${CADDY_TARGET} (стр. ${start}–${start + m[4].split("\n").length - 1})`, text: m[4], lineBase: start });
    }
  }
  const ignored: string[] = [];
  for (const cf of cfFiles) {
    const base = reEsc(path.posix.basename(cf.rel));
    const by = shFiles.find((s) => new RegExp(String.raw`\b(?:cp|install|scp|rsync)\b[^\n|;&]*${base}[^\n|;&]*\/etc\/caddy`).test(stripHash(s.text)));
    if (by) deployed.push({ label: `${cf.rel} (копируется в /etc/caddy: ${by.rel})`, text: cf.text, lineBase: 1 });
    else ignored.push(cf.rel);
  }
  return { deployed, ignored };
}

const RL_DOWNLOAD = /caddyserver\.com\/api\/download[^\s'"]*[?&]p=github\.com(?:\/|%2F)mholt(?:\/|%2F)caddy-ratelimit/i;
const RL_XCADDY = /\bxcaddy\s+build\b[^\n]*--with\s+github\.com\/mholt\/caddy-ratelimit/;
const RL_ADDPKG = /\bcaddy\s+add-package\b[^\n]*github\.com\/mholt\/caddy-ratelimit/;
const PKG_RE = /\b(?:dnf|yum|microdnf|apt|apt-get|zypper|apk|pacman)\s+(?:\S+\s+)*?(?:install|add)\b[^\n]*\scaddy(?:\s|$)/;
/** Модуль mholt/caddy-ratelimit реально в бинарнике: download API с p=…, `xcaddy build --with …` или `caddy add-package …`
 *  (комментарии сняты, команды разделены по && || ; |). Если где-то ставится стандартный пакет caddy (dnf/apt … caddy) —
 *  он без модуля, поэтому дополнительно нужна проверка `caddy list-modules … rate_limit`. */
function analyzeModule(shFiles: TextFile[]): Report {
  let evidence: string | undefined, pkg: string | undefined, verify: string | undefined, download: string | undefined;
  for (const f of shFiles) {
    stripHash(f.text).split("\n").forEach((line, i) => {
      const at = `${f.rel} стр. ${i + 1}`;
      if (!verify && /\bcaddy\s+list-modules\b/.test(line) && /rate_limit/.test(line)) verify = at;
      for (const seg of line.split(/&&|\|\||;|\|/)) {
        if (!evidence && (RL_DOWNLOAD.test(seg) || RL_XCADDY.test(seg) || RL_ADDPKG.test(seg))) evidence = at;
        if (!download && /caddyserver\.com\/api\/download|\bxcaddy\s+build\b/.test(seg)) download = at;
        if (!pkg && PKG_RE.test(seg)) pkg = at;
      }
    });
  }
  const ok = !!evidence && (!pkg || !!verify);
  const note =
    `модуль caddy-ratelimit: ${evidence ? `признак сборки с github.com/mholt/caddy-ratelimit есть (${evidence})` : `ни одна строка установки не содержит p=…mholt/caddy-ratelimit, xcaddy --with …, caddy add-package … (download API/xcaddy без модуля: ${download ?? "не найден"})`}; ` +
    `стандартный пакет caddy ${pkg ? `устанавливается (${pkg}) — ${verify ? `проверка caddy list-modules … rate_limit есть (${verify})` : "БЕЗ проверки «caddy list-modules | grep rate_limit» → этот бинарник без модуля, rate_limit не заработает"}` : "не устанавливается"}`;
  return { ok, note };
}

/* ───────────────────────────── S.1: middleware ───────────────────────────── */

const IP_HDR = String.raw`x-forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip|\b(?:req|request)\.ip\b`;
const LIMIT_NAME_RE = /\b(\w*(?:limit|max|rate|rpm|per_?min|bucket|capacity|events|burst|tokens|window)\w*)\s*(?::\s*number\s*)?[:=](?![=>])\s*([^;,\n]+)/gi;
/** Числовая константа лимита запросов (имя про лимит/окно/бакет; не duration/timeout и не лимиты S.2 reply/history/body) ≥ 1 */
function limitConst(s: string): { name: string; value: number } | undefined {
  for (const m of s.matchAll(LIMIT_NAME_RE)) {
    if (/duration|timeout|retr|reply|history|body|chars|msgs|messages|size|length/i.test(m[1])) continue;
    const v = numOf(m[2]);
    if (v !== undefined && v >= 1) return { name: m[1], value: v };
  }
  return undefined;
}
/** middleware.ts / proxy.ts: матчер /api/chat или /api/*; адрес клиента (X-Forwarded-For/X-Real-IP/req.ip) присвоен
 *  переменной, и она используется как ключ счётчика (.get/.set/.has(ip | [ip] | fn(ip, …)); ответ 429; константа лимита ≥ 1 */
function analyzeMiddleware(raw: string, label: string): Report {
  const s = stripTs(raw);
  const pathM = /\/api\/(?:chat\b|\*|:\w+\*|\(\.\*\)|\[\.\.\.)/.exec(s)?.[0];
  const ipDecl = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=[^;\n]*?(?:${IP_HDR})`, "i").exec(s);
  const ipVar = ipDecl?.[1];
  const keyed = ipVar
    ? new RegExp(String.raw`(?:\.(?:get|set|has|delete|incr\w*|consume|check|hit|take)\s*\(\s*${reEsc(ipVar)}\b|\[\s*${reEsc(ipVar)}\s*\]|(?<!console\.log|\blog)\(\s*${reEsc(ipVar)}\s*[,)])`).exec(s)?.[0]
    : undefined;
  const r429 = /\b429\b|too many requests/i.test(s);
  const lim = limitConst(s);
  const ok = !!pathM && !!keyed && r429 && !!lim;
  return {
    ok,
    note: `${label}: матчер ${pathM ?? "/api/chat|/api/* НЕТ"}; адрес клиента ${ipVar ? `→ ${ipVar}${keyed ? ` → ключ счётчика «${squash(keyed, 40)}»` : " — как ключ счётчика НЕ используется"}` : "в переменную НЕ читается"}; ` +
      `429 ${r429 ? "есть" : "НЕТ"}; константа лимита ${lim ? `${lim.name} = ${lim.value}` : "НЕТ"}`,
  };
}

/* ───────────────────────────── S.1: самопроверка и проверка ───────────────────────────── */

const CF_SNIPPET = (p: string) => `(app) {
	@chat path ${p}
	route {
		rate_limit @chat {
			zone chat {
				key {remote_host}
				events 20
				window 1m
			}
		}
		reverse_proxy 127.0.0.1:3000
	}
}
example.com {
	import app
}
http://1.2.3.4 {
	import app
}
`;
const CF_PLAIN = `# rate_limit в комментарии не считается
example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
http://1.2.3.4 {
	reverse_proxy 127.0.0.1:3000
}
`;
const CF_ONE_OF_TWO = `{
	order rate_limit before reverse_proxy
}
example.com {
	rate_limit /api/* {
		zone chat {
			key {client_ip}
			events 30
			window 1m
		}
	}
	reverse_proxy 127.0.0.1:3000
}
http://1.2.3.4 {
	reverse_proxy 127.0.0.1:3000
}
`;
const CF_NO_KEY = `example.com {
	route {
		rate_limit {
			zone chat {
				events 20
				window 1m
			}
		}
		reverse_proxy 127.0.0.1:3000
	}
}
`;
const SH_TWO_HEREDOCS = `sudo tee /etc/systemd/system/x.service >/dev/null <<'UNIT'
[Unit]
UNIT
sudo tee ${CADDY_TARGET} >/dev/null <<CADDY
example.com {
	reverse_proxy 127.0.0.1:3000
}
CADDY
cat > /tmp/other <<EOF
rate_limit
EOF
`;
const MW_FAKE = `const MAX_HISTORY_MSGS = 40;
export const config = { matcher: "/api/chat" };
export function middleware(req) {
  const fwd = req.headers.get("x-forwarded-for");
  console.log(fwd);
  if (threadCount > MAX_HISTORY_MSGS) return new Response("too many", { status: 429 });
}
`;
const MW_OK = `const RATE_LIMIT_PER_MIN = Number(process.env.SO_RATE_LIMIT ?? 20); // per-IP
const buckets = new Map<string, number>();
export const config = { matcher: "/api/:path*" };
export function middleware(req) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "?";
  const hits = buckets.get(ip) ?? 0;
  if (hits >= RATE_LIMIT_PER_MIN) return new Response(null, { status: 429 });
  buckets.set(ip, hits + 1);
}
`;
function selfTestS1() {
  const cf = (t: string) => analyzeCaddyfile(t, "test");
  selfTest("Caddy: сниппет с route+rate_limit+reverse_proxy, import в оба блока, матчер /api/*", cf(CF_SNIPPET("/api/*")).ok, cf(CF_SNIPPET("/api/*")).note);
  selfTest("Caddy: тот же сниппет с матчером /api/chat", cf(CF_SNIPPET("/api/chat")).ok, cf(CF_SNIPPET("/api/chat")).note);
  selfTest("Caddy: матчер /api/report* не покрывает /api/chat", !cf(CF_SNIPPET("/api/report*")).ok, cf(CF_SNIPPET("/api/report*")).note);
  selfTest("Caddy: без rate_limit (упоминание в комментарии не считается)", !cf(CF_PLAIN).ok, cf(CF_PLAIN).note);
  selfTest("Caddy: лимит только в одном из двух проксирующих блоков", !cf(CF_ONE_OF_TWO).ok && cf(CF_ONE_OF_TWO).note.includes("— 1."), cf(CF_ONE_OF_TWO).note);
  selfTest("Caddy: зона без key", !cf(CF_NO_KEY).ok, cf(CF_NO_KEY).note);
  const src = deployedCaddyfiles([{ rel: "x.sh", text: SH_TWO_HEREDOCS }], [{ rel: "deploy/Caddyfile", text: CF_PLAIN }]);
  selfTest("Caddy: берётся только heredoc в /etc/caddy/Caddyfile; файл без копирования — игнорируется",
    src.deployed.length === 1 && src.deployed[0].text.includes("example.com") && src.ignored.length === 1, JSON.stringify(src));
  const modOk = analyzeModule([{ rel: "x.sh", text: "sudo dnf install -y caddy\nsudo caddy add-package github.com/mholt/caddy-ratelimit\ncaddy list-modules | grep -q http.handlers.rate_limit\n" }]);
  const modNo = analyzeModule([{ rel: "x.sh", text: "sudo dnf install -y caddy\n# curl -o caddy 'https://caddyserver.com/api/download?p=github.com/mholt/caddy-ratelimit'\n" }]);
  selfTest("модуль: пакет + add-package + list-modules → OK", modOk.ok, modOk.note);
  selfTest("модуль: пакет без модуля, p= только в комментарии → не OK", !modNo.ok, modNo.note);
  selfTest("middleware: X-Forwarded-For только в лог + 429 на другой лимит → не OK", !analyzeMiddleware(MW_FAKE, "t").ok, analyzeMiddleware(MW_FAKE, "t").note);
  selfTest("middleware: ip → ключ Map, 429, константа per-IP, матчер /api/:path* → OK", analyzeMiddleware(MW_OK, "t").ok, analyzeMiddleware(MW_OK, "t").note);
}

function s1(): Verdict {
  selfTestS1();
  const shFiles: TextFile[] = deployFiles((b) => /\.sh$/.test(b)).map((rel) => ({ rel, text: readSrc(rel) }));
  const cfFiles: TextFile[] = deployFiles((b) => /^Caddyfile/i.test(b) || /\.caddy$/i.test(b)).map((rel) => ({ rel, text: readSrc(rel) }));
  const { deployed, ignored } = deployedCaddyfiles(shFiles, cfFiles);
  const cfParts = deployed.map((d) => analyzeCaddyfile(d.text, d.label, d.lineBase));
  const mod = analyzeModule(shFiles);
  const caddyOk = deployed.length > 0 && cfParts.every((p) => p.ok) && mod.ok;
  const caddyNote =
    (deployed.length ? cfParts.map((p) => p.note).join(" · ") : `Caddyfile, записываемый в ${CADDY_TARGET}, не найден (heredoc tee/> в deploy/**/*.sh или файл deploy/**/Caddyfile*, копируемый в /etc/caddy)`) +
    (ignored.length ? `; не деплоятся (никто не копирует в /etc/caddy): ${ignored.join(", ")}` : "") +
    `; ${mod.note}`;
  const mwCands = ["middleware.ts", "proxy.ts", "src/middleware.ts", "src/proxy.ts"].map((f) => `${WEB}/${f}`).filter(exists);
  const mwParts = mwCands.map((f) => analyzeMiddleware(readSrc(f), f));
  const mwOk = mwParts.some((p) => p.ok);
  const mwNote = mwCands.length ? mwParts.map((p) => p.note).join("; ") : `${WEB}/{middleware,proxy}.ts (и src/) — файлов нет`;
  const ok = caddyOk || mwOk;
  const notes = [`[A] Caddy — ${caddyNote}`, `[B] middleware — ${mwNote}`];
  if (!ok) {
    const route = stripTs(readSrc(ROUTE));
    const sessionSrc = exists(SESSION) ? readSrc(SESSION) : "";
    const msgLimit = /SO_MESSAGE_LIMIT\s*\?\?\s*(\d+)/.exec(sessionSrc)?.[1] ?? "?";
    notes.push(
      `сейчас: сессия и MESSAGE_LIMIT=${msgLimit} — по client-side body.id (route.ts стр. ${lineOf(route, route.indexOf("getSession("))}), не по IP → ` +
        `единственный предохранитель стенда = SO_DAILY_BUDGET_USD (один скрипт за ~$2 отключает ассистента для всех до полуночи МСК)`,
    );
  }
  notes.push(
    "распознаётся: [A] rate_limit (прямо, через сниппет, внутри route) в каждом блоке с reverse_proxy →:3000; матчер без/`*`/путь-глоб/@name с path|path_regexp; " +
      "zone key {remote_host|client_ip}, events ≥ 1, window; модуль — download p=, xcaddy --with, caddy add-package (+ list-modules при пакете). " +
      "[B] переменная с адресом клиента как ключ счётчика + 429 + числовая константа лимита + матчер /api/chat|/api/*. " +
      "НЕ распознаётся: лимитер в route.ts/lib, внешний WAF/CDN, Caddy JSON-конфиг, путь Caddyfile через переменную, лимит в middleware без константы",
  );
  return expect(ok, notes.join(" · "));
}

/* ───────────────────────────── S.2 ───────────────────────────── */

type Subject = "reply" | "count" | "chars" | "other";
interface Cmp { at: number; text: string; subject: Subject; limId: string; truncate: boolean }
interface Judged extends Cmp { ok: boolean; desc: string }
interface RouteAnalysis { cutoffNote: string; reply: Report; count: Report; chars: Report; others: number; textVar: string; src: string }
const JEV_CALL = /(?<![\w$.])(runGate|routeMessage|streamText|generateText)\s*\(/g;
const EXPR = String.raw`[A-Za-z_$][\w$.]*(?:\([^()]*\))?`;

/** route.ts (комментарии сняты): зона раннего выхода = до первого вызова Jev/модели, а если он внутри
 *  `createUIMessageStream(…)` — до начала этого вызова (ответ-стрим 200 уже создаётся, 413 изнутри не дойдёт).
 *  Кандидаты — ВСЕ сравнения `<expr>.length OP <lim>` (и зеркальные `<lim> OP <expr>.length`), сравнения Content-Length,
 *  обрезки `messages….slice(-N)`. Кандидат засчитывается, если он в зоне раннего выхода, предел распознан и в [1; план],
 *  и он стоит в условии if/while, в блоке которого есть 400/413 (прямо или через helper `return f(…)`) либо обрезка
 *  slice/splice/shift; обрезка slice(-N) — сама по себе. */
function analyzeRoute(rawRoute: string, libSources: string[]): RouteAnalysis | undefined {
  const src = stripTs(rawRoute);
  const scope = [src, ...libSources.map(stripTs)].join("\n");
  const textVar = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*textOf\(/.exec(src)?.[1] ?? "text";
  const jev = [...src.matchAll(JEV_CALL)][0];
  if (!jev || jev.index === undefined) return undefined;
  const jevAt = jev.index;
  let cutoff = jevAt;
  let cutoffNote = `${jev[1]}( стр. ${lineOf(src, cutoff)}`;
  for (const m of src.matchAll(/(?<![\w$.])createUIMessageStream\s*\(/g)) {
    if (m.index === undefined || m.index >= jevAt) break;
    if (balanced(src, m.index + m[0].length - 1) > jevAt) {
      cutoff = m.index;
      cutoffNote = `createUIMessageStream( стр. ${lineOf(src, cutoff)}, внутри него ${jev[1]}( стр. ${lineOf(src, jevAt)} — проверка внутри execute опоздала: 200-стрим уже отдан`;
      break;
    }
  }
  const classify = (e: string): Subject => {
    if (e === textVar || /textOf\(|(?:^|[._])(?:text|reply|utterance)/i.test(e)) return "reply";
    if (/(?:^|[._])(?:messages|history|\w*msgs)$/i.test(e)) return "count";
    if (/JSON\.stringify\(|byteLength|content-length|(?:^|[._])(?:raw|body|payload|json|total|chars|bytes|size|len)\w*$/i.test(e)) return "chars";
    return "other";
  };
  const cmps: Cmp[] = [];
  for (const m of src.matchAll(new RegExp(String.raw`\b(${EXPR})\.length\s*(?:>=?|<=?)\s*(${EXPR}|${NUM})`, "g")))
    cmps.push({ at: m.index ?? 0, text: m[0], subject: classify(m[1]), limId: m[2], truncate: false });
  for (const m of src.matchAll(new RegExp(String.raw`(?<![\w$.])(${EXPR}|${NUM})\s*(?:>=?|<=?)\s*(${EXPR})\.length\b`, "g")))
    if (!/\.length$/.test(m[1])) cmps.push({ at: m.index ?? 0, text: m[0], subject: classify(m[2]), limId: m[1], truncate: false });
  for (const m of src.matchAll(new RegExp(String.raw`(?:Number|parseInt)\(\s*req\.headers\.get\(\s*["']content-length["']\s*\)[^)\n]*\)\s*(?:>=?)\s*(${EXPR}|${NUM})`, "gi")))
    cmps.push({ at: m.index ?? 0, text: m[0], subject: "chars", limId: m[1], truncate: false });
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:messages|history|\w*msgs)\b[^;\n]*?\.slice\(\s*-\s*(${EXPR}|${NUM})\s*\)`, "gi")))
    cmps.push({ at: m.index ?? 0, text: m[0], subject: "count", limId: m[1], truncate: true });

  const judge = (c: Cmp): Judged => {
    const why: string[] = [];
    if (c.at >= cutoff) why.push("вне зоны раннего выхода (после/внутри стрима)");
    const lim = resolveLimit(c.limId, scope);
    const bound = c.subject === "other" ? undefined : PLAN[c.subject];
    if (lim.value === undefined) why.push(`предел ${c.limId} не распознан${lim.decl ? ` (объявление: ${lim.decl})` : " (объявления нет)"}`);
    else if (lim.value < 1) why.push(`предел ${lim.value} < 1`);
    else if (bound !== undefined && lim.value > bound) why.push(`предел ${lim.value} > плана ${bound}`);
    let how: string | undefined;
    if (c.truncate) how = "обрезка истории slice(-N)";
    else {
      const blk = condBlockAround(src, c.at);
      if (!blk) why.push("не в условии if/while");
      else {
        const st = /\b(400|413)\b/.exec(blk.block)?.[1];
        const helper = st ? undefined : /\breturn\s+([A-Za-z_$][\w$]*)\s*\(/.exec(blk.block)?.[1];
        const hs = helper ? helperStatus(helper, scope) : undefined;
        if (st) how = `ответ ${st}`;
        else if (hs) how = `ответ ${hs} (через ${helper}())`;
        else if (/\.(?:slice|splice|shift)\s*\(/.test(blk.block)) how = "обрезка истории в блоке";
        else why.push(`в блоке if нет 400/413${helper ? ` (helper ${helper}() без 400/413)` : ""} и нет обрезки`);
      }
    }
    const ok = !why.length && !!how;
    const desc = `стр. ${lineOf(src, c.at)} «${squash(c.text, 60)}»` + (ok ? ` — предел ${lim.value}, ${how}, до ${jev[1]}(` : ` — ${why.join("; ")}`);
    return { ...c, ok, desc };
  };
  const judged = cmps.sort((a, b) => a.at - b.at).map(judge);
  const bySubject = (s: Subject, label: string): Report => {
    const cs = judged.filter((c) => c.subject === s);
    const good = cs.find((c) => c.ok);
    return {
      ok: !!good,
      note: `${label}: ${good ? `есть (${good.desc})` : cs.length ? `НЕТ — кандидаты отклонены: ${cs.map((c) => c.desc).join("; ")}` : "НЕТ (сравнений не найдено)"}`,
    };
  };
  return {
    cutoffNote,
    reply: bySubject("reply", "лимит реплики"),
    count: bySubject("count", "лимит числа сообщений истории"),
    chars: bySubject("chars", "лимит объёма истории/тела"),
    others: judged.filter((c) => c.subject === "other").length,
    textVar,
    src,
  };
}

/* контрольный маршрут: комментарий со словами runGate/streamText над проверками, шум `text.length > 0`, тернарник env,
 * helper tooLarge(), обрезка slice(-N), `20_000`; маркер //@LIMITS@ — до стрима, //@INSIDE@ — внутри execute */
const SYN_ROUTE = `import { createUIMessageStream, createUIMessageStreamResponse, streamText } from "ai";
import { runGate } from "@/lib/gate";
const MAX_REPLY_CHARS = process.env.SO_MAX_REPLY ? Number(process.env.SO_MAX_REPLY) : 2000;
const MAX_HISTORY_MSGS = Number(process.env.SO_MAX_HISTORY ?? 40);
const MAX_HISTORY_CHARS = 20_000;
const tooLarge = (why: string) =>
  new Response(why, { status: 413 });
export async function POST(req: Request) {
  const body = (await req.json()) as { messages: UIMessage[] };
  let messages = body.messages ?? [];
  const text = textOf(lastUser);
  const hasText = text.length > 0;
  /* Лимиты размера запроса (план WP-S, S.2) — строго до runGate() и streamText() */
  //@LIMITS@
  const stream = createUIMessageStream({
    originalMessages: messages,
    execute: async ({ writer }) => {
      //@INSIDE@
      const gate = text ? await runGate(writer, session, text, null) : { handled: false };
      const result = streamText({ messages });
    },
  });
  return createUIMessageStreamResponse({ stream });
}
`;
const SYN_LIMITS = `if (text.length > MAX_REPLY_CHARS) return tooLarge("реплика длиннее лимита");
  if (messages.length > MAX_HISTORY_MSGS) messages = messages.slice(-MAX_HISTORY_MSGS);
  if (JSON.stringify(messages).length > MAX_HISTORY_CHARS) return new Response("история", { status: 413 });`;
function selfTestS2() {
  const run = (t: string) => analyzeRoute(t, []);
  const show = (a: RouteAnalysis | undefined) => (a ? [a.cutoffNote, a.reply.note, a.count.note, a.chars.note].join(" | ") : "анализ не выполнен");
  const okAll = run(SYN_ROUTE.replace("//@LIMITS@", SYN_LIMITS));
  selfTest("S.2: три лимита до стрима (комментарий с runGate выше, шум text.length > 0, тернарник, helper, slice) → все OK",
    !!okAll && okAll.reply.ok && okAll.count.ok && okAll.chars.ok, show(okAll));
  const inside = run(SYN_ROUTE.replace("//@INSIDE@", SYN_LIMITS));
  selfTest("S.2: те же проверки внутри execute → ни одна не засчитана", !!inside && !inside.reply.ok && !inside.count.ok && !inside.chars.ok, show(inside));
  const none = run(SYN_ROUTE);
  selfTest("S.2: без проверок → НЕТ", !!none && !none.reply.ok && !none.count.ok && !none.chars.ok, show(none));
  const big = run(SYN_ROUTE.replace("//@LIMITS@", 'if (text.length > 5000) return new Response("x", { status: 413 });'));
  selfTest("S.2: предел 5000 > плана 2000 → не OK", !!big && !big.reply.ok && big.reply.note.includes("> плана"), show(big));
  const noStatus = run(SYN_ROUTE.replace("//@LIMITS@", 'if (text.length > MAX_REPLY_CHARS) return plainReply("x");'));
  selfTest("S.2: без 400/413 (helper без статуса) → не OK", !!noStatus && !noStatus.reply.ok, show(noStatus));
}

function s2(): Verdict {
  selfTestS2();
  const raw = readSrc(ROUTE);
  const libs = libClosure(libNames(raw), 2).map(libSrc);
  const a = analyzeRoute(raw, libs);
  if (!a) return { pass: false, detail: "route.ts: нет вызовов runGate/routeMessage/streamText/generateText — структура изменилась, проверку нужно обновить" };
  const L = (needle: string) => lineOf(a.src, a.src.indexOf(needle));
  const detail =
    `route.ts (комментарии сняты): зона раннего выхода — до ${a.cutoffNote}; до неё ${a.textVar} = textOf(lastUser) стр. ${L("textOf(lastUser)")}, ` +
    `messages = body.messages стр. ${L("body.messages")}, req.json() стр. ${L("req.json()")}. ` +
    `${a.reply.note}; ${a.count.note}; ${a.chars.note}; прочих сравнений .length: ${a.others}. ` +
    `План: реплика ≤ ${PLAN.reply} симв., история ≤ ${PLAN.count} сообщений / ≤ ${PLAN.chars} симв. → 413/400 до runGate (все три). ` +
    "Распознаётся: сравнение .length/Content-Length с литералом или константой (любое имя; Number(env ?? N), env ? Number(env) : N, parseInt) " +
    "в условии if/while, в блоке которого 400/413 (прямо или через helper-функцию) либо обрезка slice/splice/shift; обрезка messages.slice(-N). " +
    "НЕ распознаётся: zod .max/.refine, лимит в middleware или lib-валидаторе, двухшаговая форма const over = …; if (over), статус через константу, арифметика в пределе";
  return expect(a.reply.ok && a.count.ok && a.chars.ok, detail);
}

/* ───────────────────────────── S.3 (guard) ───────────────────────────── */

interface BudgetProbe { exhausted: boolean; spent: number; day: string; limit: number }
interface ProbeOut {
  limit: number; today: string; yesterday: string; clockNow: string; boundaryLate: string; boundaryEarly: string;
  over: BudgetProbe; equal: BudgetProbe; under: BudgetProbe; stale: BudgetProbe; huge: BudgetProbe;
}

/** budget.ts в дочернем процессе: изолированный SO_USAGE_DIR, часы заморожены на FIXED_ISO (подмена глобального Date
 *  ДО импорта модуля — и `new Date()` без аргументов, и `Date.now()` возвращают фиксированный момент) */
function runBudgetProbe(dailyLimit: string): ProbeOut {
  const budgetUrl = pathToFileURL(path.join(REPO_ROOT, WEB, "lib", "budget.ts")).href;
  const code = [
    'import fs from "node:fs"; import path from "node:path";',
    "const FIXED = Date.parse(process.env.AUDIT_FIXED_ISO); const RealDate = Date;",
    "class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } }",
    "globalThis.Date = FixedDate;",
    "const m0 = await import(process.env.AUDIT_BUDGET_URL); const m = typeof m0.mskDay === 'function' ? m0 : m0.default;",
    'const file = path.join(process.env.SO_USAGE_DIR, "budget.json");',
    "const today = m.mskDay(), yesterday = m.mskDay(new RealDate(FIXED - 86_400_000));",
    "const probe = (b) => { fs.writeFileSync(file, JSON.stringify(b)); const s = m.budgetState(); return { exhausted: s.exhausted, spent: s.spent, day: s.day, limit: s.limit }; };",
    "console.log(JSON.stringify({ limit: m.DAILY_BUDGET_USD, today, yesterday, clockNow: new Date().toISOString(),",
    '  boundaryLate: m.mskDay(new RealDate("2026-10-09T21:00:00Z")), boundaryEarly: m.mskDay(new RealDate("2026-10-09T20:59:59Z")),',
    "  over: probe({ day: today, spent: 2.5, messages: 3 }), equal: probe({ day: today, spent: 2, messages: 1 }),",
    "  under: probe({ day: today, spent: 1.99, messages: 3 }), stale: probe({ day: yesterday, spent: 9, messages: 9 }),",
    "  huge: probe({ day: today, spent: 100, messages: 1 }) }));",
  ].join("\n");
  /* Загрузчик tsx — по абсолютному URL (раннер уже работает под tsx), чтобы не зависеть от cwd дочернего процесса */
  let tsxLoader = "tsx";
  try { tsxLoader = import.meta.resolve("tsx"); } catch { /* fallback: bare specifier, резолв от cwd */ }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "so-audit-s3-"));
  try {
    const out = execFileSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", code], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SO_USAGE_DIR: dir, SO_DAILY_BUDGET_USD: dailyLimit, AUDIT_BUDGET_URL: budgetUrl, AUDIT_FIXED_ISO: FIXED_ISO },
    });
    return JSON.parse(out.trim().split("\n").pop()!) as ProbeOut;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function s3(): Verdict {
  const route = stripTs(readSrc(ROUTE)); // позиции и номера строк — по тексту без комментариев
  const L = (i: number) => lineOf(route, i);
  const callIdx = (names: string[]) => {
    const xs = [...route.matchAll(new RegExp(String.raw`(?<![\w$.])(?:${names.join("|")})\s*\(`, "g"))].map((m) => m.index ?? -1).filter((i) => i >= 0);
    return xs.length ? Math.min(...xs) : -1;
  };
  const iGate = callIdx(["runGate", "routeMessage"]);
  const iModel = callIdx(["streamText", "generateText"]);
  const iStream = route.indexOf("originalMessages");
  const iCount = callIdx(["countMessage"]);

  /* 1. Дневной бюджет: budgetState() → if (….exhausted) { … return … } раньше countMessage/stream/Jev/модели */
  const iBudget = callIdx(["budgetState"]);
  const iEx = route.indexOf(".exhausted");
  const exIf = iEx >= 0 ? condBlockAround(route, iEx) : undefined;
  const after = [iCount, iStream, iGate, iModel].filter((i) => i > iEx);
  const until = after.length ? Math.min(...after) : route.length;
  const exReturn = exIf ? /\breturn\b/.test(exIf.block) : iEx >= 0 && /\breturn\b/.test(route.slice(iEx, until));
  const budgetOk = iBudget >= 0 && iEx > iBudget && exReturn && iGate > iEx && iModel > iEx && (iStream < 0 || iStream > iEx);
  const budgetNote =
    `бюджет: budgetState() стр. ${L(iBudget)} → if (${exIf ? squash(exIf.cond, 40) : "?"}) ${exReturn ? "с return" : "БЕЗ return"} стр. ${L(iEx)}` +
    `${exIf ? ` (блок ${exIf.block.split("\n").length} стр.)` : ""}; после: countMessage() стр. ${L(iCount)}, originalMessages стр. ${L(iStream)}, runGate( стр. ${L(iGate)}, streamText( стр. ${L(iModel)}` +
    (budgetOk ? "" : " — ПОРЯДОК НАРУШЕН");

  /* 2. Per-thread лимит: ключ сессии — client-side id (не IP), счётчик +1, ранний return при > MESSAGE_LIMIT, всё до Jev/модели */
  const iSess = callIdx(["getSession"]);
  const sessOpen = iSess >= 0 ? route.indexOf("(", iSess) : -1;
  const sessClose = sessOpen >= 0 ? balanced(route, sessOpen) : -1;
  const sessArg = sessClose > 0 ? route.slice(sessOpen + 1, sessClose) : "";
  const sessByClientId = /\b(?:\w+\.)?id\b/.test(sessArg) && !new RegExp(IP_HDR, "i").test(sessArg);
  const incM = /session\.userMessages\s*(?:\+=\s*1|\+\+)/.exec(route);
  const limM = /if\s*\(\s*session\.userMessages\s*>\s*MESSAGE_LIMIT\s*\)/.exec(route);
  const limIf = limM ? condBlockAround(route, limM.index + limM[0].length - 1) : undefined;
  const limReturn = !!limIf && /\breturn\b/.test(limIf.block);
  const sessionSrc = exists(SESSION) ? stripTs(readSrc(SESSION)) : "";
  const mlM = /export\s+const\s+MESSAGE_LIMIT\s*=\s*Number\(\s*process\.env\.SO_MESSAGE_LIMIT\s*\?\?\s*(\d[\d_]*)\s*\)/.exec(sessionSrc);
  const mlDefault = mlM ? toNum(mlM[1]) : undefined;
  const threadOk =
    iSess >= 0 && sessByClientId && !!incM && incM.index < iGate && !!limM && limReturn &&
    limM.index < iGate && limM.index < iModel && (iStream < 0 || limM.index < iStream) && mlDefault !== undefined && mlDefault >= 1;
  const threadNote =
    `per-thread: getSession(${squash(sessArg, 60)}) стр. ${L(iSess)} — ключ ${sessByClientId ? "client-side id, не IP" : "НЕ client-side id / по IP"}; ` +
    `session.userMessages ${incM ? `+1 стр. ${L(incM.index)}` : "НЕ инкрементируется"}; ` +
    `if (session.userMessages > MESSAGE_LIMIT) ${limM ? `стр. ${L(limM.index)} ${limReturn ? "с return" : "БЕЗ return"}` : "НЕТ"}; ` +
    `lib/session.ts: ${mlM ? `export const MESSAGE_LIMIT = Number(process.env.SO_MESSAGE_LIMIT ?? ${mlM[1]})` : "export const MESSAGE_LIMIT = Number(process.env.SO_MESSAGE_LIMIT ?? N) НЕ НАЙДЕН"}` +
    (threadOk ? "" : " — НАРУШЕНО");

  /* 3. Семантика budgetState при замороженных часах */
  const p2 = runBudgetProbe("2");
  const p0 = runBudgetProbe("0");
  const clockOk = p2.today === FIXED_MSK_DAY && p2.yesterday === "2026-10-08" && p2.clockNow === "2026-10-09T12:00:00.000Z" &&
    p2.boundaryLate === "2026-10-10" && p2.boundaryEarly === "2026-10-09";
  const dynOk =
    clockOk && p2.limit === 2 && p2.over.exhausted && p2.equal.exhausted && !p2.under.exhausted &&
    !p2.stale.exhausted && p2.stale.spent === 0 && p2.stale.day === FIXED_MSK_DAY && p2.huge.exhausted &&
    p0.limit === 0 && !p0.huge.exhausted;
  const yn = (b: boolean) => (b ? "true" : "false");
  const dynNote =
    `budgetState() (изолированный .usage, часы заморожены ${p2.clockNow} → mskDay ${p2.today}${clockOk ? "" : " — ЧАСЫ НЕ ЗАМОРОЖЕНЫ"}; ` +
    `граница суток МСК: 21:00Z→${p2.boundaryLate}, 20:59:59Z→${p2.boundaryEarly}; лимит ${p2.limit}): ` +
    `spent 2.5→exhausted ${yn(p2.over.exhausted)}, 2.0→${yn(p2.equal.exhausted)}, 1.99→${yn(p2.under.exhausted)}, ` +
    `вчерашний день (${p2.yesterday}) spent 9→${yn(p2.stale.exhausted)} (spent ${p2.stale.spent}, day ${p2.stale.day}), 100→${yn(p2.huge.exhausted)}; ` +
    `SO_DAILY_BUDGET_USD=0 при spent 100→${yn(p0.huge.exhausted)} (limit ${p0.limit}, без лимита)`;
  return expect(budgetOk && threadOk && dynOk, `${budgetNote} · ${threadNote} · ${dynNote}`);
}

export const checks: Check[] = [
  {
    id: "S.1",
    wp: "S",
    kind: "static",
    title: "Per-IP лимит на /api/chat: rate_limit в Caddyfile, записываемом в /etc/caddy/Caddyfile (+ модуль caddy-ratelimit в сборке), либо лимитер в middleware.ts (static, комментарии сняты)",
    run: s1,
  },
  {
    id: "S.2",
    wp: "S",
    kind: "static",
    title: "Длина реплики и объём истории ограничены до Jev/модели — 413/400 или обрезка в зоне раннего выхода (static: сравнения .length, не zod/middleware)",
    run: s2,
  },
  {
    id: "S.3",
    wp: "S",
    kind: "static",
    guard: true,
    title: "Предохранители стенда (дневной бюджет + per-thread лимит сообщений) стоят до Jev/модели",
    run: s3,
  },
];
