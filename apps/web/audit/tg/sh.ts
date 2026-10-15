/**
 * WP-TG: маленький разборщик bash для статической части TG.23 (deploy.sh). Только то, что нужно проверке:
 *  - слова команд с кавычками '…' и "…", подстановками $(…), $((…)), ${…}, $VAR и `…`; соседние куски — одно слово
 *    ('getMe ok version='"$SHA" — одно слово из литерала и переменной);
 *  - операторы и переводы строк как разделители команд, комментарии `# …`, here-doc (<<EOF … EOF, <<-), продолжение строки «\»;
 *  - определения функций `name() { … }` и `function name { … }` с поиском закрывающей скобки по балансу;
 *  - команды trap (вне основного потока выполнения).
 * Это не интерпретатор: подстановки не выполняются и остаются кусками (var/cmd) со своим исходным текстом.
 */

export class ShParseError extends Error {}

export type Piece = { k: "lit"; s: string } | { k: "var"; raw: string } | { k: "cmd"; raw: string };
export interface Word { pieces: Piece[]; start: number; end: number }
export type Tok = { t: "word"; w: Word } | { t: "op"; op: string; start: number } | { t: "nl"; start: number };

const NAME0 = /[A-Za-z_]/;
const NAME1 = /[A-Za-z0-9_]/;
const SPECIAL = /[@*#?$!0-9-]/;

/** Позиция после закрывающей «'» (src[i] === "'") */
function skipSq(src: string, i: number): number {
  const e = src.indexOf("'", i + 1);
  if (e < 0) throw new ShParseError(`незакрытая «'» с позиции ${i}`);
  return e + 1;
}
/** Позиция после закрывающей «`» (src[i] === "`") */
function skipBq(src: string, i: number): number {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === "`") return j + 1;
  }
  throw new ShParseError(`незакрытая «\`» с позиции ${i}`);
}
/** Позиция после закрывающей «"» (src[i] === '"'); внутри — экранирование, $(…), ${…}, `…` */
function skipDq(src: string, i: number): number {
  for (let j = i + 1; j < src.length;) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === '"') return j + 1;
    if (c === "$" && src[j + 1] === "(") { j = skipCmdSub(src, j); continue; }
    if (c === "$" && src[j + 1] === "{") { j = skipBrace(src, j); continue; }
    if (c === "`") { j = skipBq(src, j); continue; }
    j++;
  }
  throw new ShParseError(`незакрытая «"» с позиции ${i}`);
}
/** Позиция после парной «)» для $( … ) и $(( … )) (src[i] === "$", src[i + 1] === "(") */
export function skipCmdSub(src: string, i: number): number {
  let depth = 0;
  for (let j = i + 1; j < src.length;) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "'") { j = skipSq(src, j); continue; }
    if (c === '"') { j = skipDq(src, j); continue; }
    if (c === "`") { j = skipBq(src, j); continue; }
    if (c === "$" && src[j + 1] === "{") { j = skipBrace(src, j); continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j + 1;
    j++;
  }
  throw new ShParseError(`незакрытая «$(» с позиции ${i}`);
}
/** Позиция после парной «}» для ${ … } (src[i] === "$", src[i + 1] === "{") */
function skipBrace(src: string, i: number): number {
  let depth = 0;
  for (let j = i + 1; j < src.length;) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "'") { j = skipSq(src, j); continue; }
    if (c === '"') { j = skipDq(src, j); continue; }
    if (c === "$" && src[j + 1] === "(") { j = skipCmdSub(src, j); continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j + 1;
    j++;
  }
  throw new ShParseError(`незакрытая «\${» с позиции ${i}`);
}

/** «$…» в позиции i → кусок и позиция после него; null — одиночный «$» (литерал) */
function readDollar(src: string, i: number, inDq = false): { p: Piece; end: number } | null {
  const d = src[i + 1] ?? "";
  if (d === "(") { const e = skipCmdSub(src, i); return { p: { k: "cmd", raw: src.slice(i, e) }, end: e }; }
  if (d === "{") { const e = skipBrace(src, i); return { p: { k: "var", raw: src.slice(i, e) }, end: e }; }
  if (NAME0.test(d)) { let e = i + 2; while (e < src.length && NAME1.test(src[e])) e++; return { p: { k: "var", raw: src.slice(i, e) }, end: e }; }
  if (d && SPECIAL.test(d)) return { p: { k: "var", raw: src.slice(i, i + 2) }, end: i + 2 };
  if (d === "'" && !inDq) { // $'…' (ANSI-C): \' и \\ — экранирование, остальное как есть
    let s = "";
    for (let j = i + 2; j < src.length; j++) {
      if (src[j] === "\\") { const n = src[j + 1] ?? ""; s += n === "n" ? "\n" : n === "t" ? "\t" : n; j++; continue; }
      if (src[j] === "'") return { p: { k: "lit", s }, end: j + 1 };
      s += src[j];
    }
    throw new ShParseError(`незакрытая «$'» с позиции ${i}`);
  }
  return null;
}

const OPS = ["&&", "||", ";;", "|&", "<<<", "<<-", "<<", ">>", "&>", ">&", "|", "&", ";", "(", ")", "<", ">"];
/** Разделители команд (перенаправления — не разделители) */
const SEPARATORS = new Set(["&&", "||", ";;", "|&", "|", "&", ";", "(", ")"]);

/** Текст слова: литералы как есть, подстановки — исходным текстом */
export const wordText = (w: Word): string => w.pieces.map((p) => (p.k === "lit" ? p.s : p.raw)).join("");
/** Слово без подстановок → его литерал; иначе null */
export const wordLit = (w: Word): string | null => (w.pieces.every((p) => p.k === "lit") ? w.pieces.map((p) => (p as { s: string }).s).join("") : null);

/** here-doc: пропустить тела ожидающих here-doc, начиная со строки в позиции i; вернуть позицию после последнего ограничителя */
function skipHeredocs(src: string, i: number, docs: { delim: string; strip: boolean }[]): number {
  let j = i;
  for (const d of docs) {
    while (j < src.length) {
      const e = src.indexOf("\n", j);
      const line = src.slice(j, e < 0 ? src.length : e);
      j = e < 0 ? src.length : e + 1;
      if ((d.strip ? line.replace(/^\t+/, "") : line) === d.delim) break;
    }
  }
  return j;
}

/** Токены: слова (из кусков), операторы, переводы строк. Комментарии и тела here-doc пропускаются. @throws ShParseError */
export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let cur: Piece[] | null = null;
  let curStart = 0;
  let pendingDelim: string | null = null;
  const docs: { delim: string; strip: boolean }[] = [];
  const open = (at: number) => { if (!cur) { cur = []; curStart = at; } return cur; };
  const lit = (at: number, s: string) => {
    const c = open(at);
    const last = c[c.length - 1];
    if (last && last.k === "lit") last.s += s; else c.push({ k: "lit", s });
  };
  const flush = (end: number) => {
    if (!cur) return;
    const w: Word = { pieces: cur, start: curStart, end };
    toks.push({ t: "word", w });
    cur = null;
    if (pendingDelim) { docs.push({ delim: wordText(w), strip: pendingDelim === "<<-" }); pendingDelim = null; }
  };
  for (let i = 0; i < n;) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] === "\n") { i += 2; continue; } // продолжение строки
      lit(i, src[i + 1] ?? ""); i += 2; continue;
    }
    if (c === " " || c === "\t" || c === "\r") { flush(i); i++; continue; }
    if (c === "\n") {
      flush(i); toks.push({ t: "nl", start: i }); i++;
      if (docs.length) i = skipHeredocs(src, i, docs.splice(0));
      continue;
    }
    if (c === "#" && !cur) { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "'") { const e = skipSq(src, i); lit(i, src.slice(i + 1, e - 1)); i = e; continue; }
    if (c === '"') {
      const at = i;
      lit(at, "");
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new ShParseError(`незакрытая «"» с позиции ${at}`);
        const d = src[j];
        if (d === '"') { j++; break; }
        if (d === "\\") {
          const x = src[j + 1] ?? "";
          if (x === "\n") { j += 2; continue; }
          if ("$`\"\\".includes(x)) { lit(at, x); j += 2; continue; }
          lit(at, "\\"); j++; continue;
        }
        if (d === "$") { const r = readDollar(src, j, true); if (r && r.p.k !== "lit") { open(at).push(r.p); j = r.end; continue; } lit(at, "$"); j++; continue; }
        if (d === "`") { const e = skipBq(src, j); open(at).push({ k: "cmd", raw: src.slice(j, e) }); j = e; continue; }
        lit(at, d); j++;
      }
      i = j; continue;
    }
    if (c === "$") {
      const r = readDollar(src, i);
      if (r) { if (r.p.k === "lit") lit(i, r.p.s); else open(i).push(r.p); i = r.end; continue; }
      lit(i, "$"); i++; continue;
    }
    if (c === "`") { const e = skipBq(src, i); open(i).push({ k: "cmd", raw: src.slice(i, e) }); i = e; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      flush(i);
      toks.push({ t: "op", op, start: i });
      if (op === "<<" || op === "<<-") pendingDelim = op;
      i += op.length; continue;
    }
    lit(i, c); i++;
  }
  flush(n);
  return toks;
}

/** Команды: слова между разделителями (переводы строк, ; && || | & ( )); перенаправления остаются внутри команды */
export function commands(toks: Tok[]): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const t of toks) {
    if (t.t === "word") cur.push(t.w);
    else if (t.t === "nl" || SEPARATORS.has(t.op)) { if (cur.length) out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Позиция парной «}» для «{» в позиции open (кавычки, подстановки, комментарии и here-doc пропускаются); -1 — нет пары */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  let pendingDoc: { delim: string; strip: boolean } | null = null;
  for (let j = open; j < src.length;) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "'") { j = skipSq(src, j); continue; }
    if (c === '"') { j = skipDq(src, j); continue; }
    if (c === "`") { j = skipBq(src, j); continue; }
    if (c === "$" && src[j + 1] === "(") { j = skipCmdSub(src, j); continue; }
    if (c === "$" && src[j + 1] === "{") { j = skipBrace(src, j); continue; }
    if (c === "#" && (j === 0 || /[\s;&|(]/.test(src[j - 1]))) { while (j < src.length && src[j] !== "\n") j++; continue; }
    if (c === "<" && src.startsWith("<<", j) && !src.startsWith("<<<", j)) {
      const m = src.slice(j).match(/^<<(-?)[ \t]*(['"]?)([A-Za-z_][\w]*)\2/);
      if (m) { pendingDoc = { delim: m[3], strip: m[1] === "-" }; j += m[0].length; continue; }
    }
    if (c === "\n" && pendingDoc) { j = skipHeredocs(src, j + 1, [pendingDoc]); pendingDoc = null; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j;
    j++;
  }
  return -1;
}

export interface ShFn { name: string; start: number; bodyStart: number; end: number; body: string }
/** Определения функций верхнего уровня: name() { … } и function name [()] { … }. @throws ShParseError — нет закрывающей «}» */
export function shFunctions(src: string): ShFn[] {
  const re = /^[ \t]*(?:function[ \t]+([A-Za-z_][\w-]*)[ \t]*(?:\([ \t]*\))?|([A-Za-z_][\w-]*)[ \t]*\([ \t]*\))[ \t\n]*\{/gm;
  const out: ShFn[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(src, open);
    const name = m[1] ?? m[2];
    if (close < 0) throw new ShParseError(`у функции ${name} (позиция ${m.index}) нет закрывающей «}»`);
    out.push({ name, start: m.index, bodyStart: open + 1, end: close + 1, body: src.slice(open + 1, close) });
    re.lastIndex = close + 1;
  }
  return out;
}

/** Конец команды, начатой в позиции i: первый вне кавычек и подстановок «\n» (без «\» перед ним), «;», «&» или «|» */
function commandEnd(src: string, i: number): number {
  for (let j = i; j < src.length;) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "'") { j = skipSq(src, j); continue; }
    if (c === '"') { j = skipDq(src, j); continue; }
    if (c === "`") { j = skipBq(src, j); continue; }
    if (c === "$" && src[j + 1] === "(") { j = skipCmdSub(src, j); continue; }
    if (c === "$" && src[j + 1] === "{") { j = skipBrace(src, j); continue; }
    if (c === "\n" || c === ";" || c === "&" || c === "|") return j;
    j++;
  }
  return src.length;
}

/** Заменить диапазон пробелами, сохранив переводы строк (смещения и номера строк не меняются) */
export const blank = (text: string, s: number, e: number): string => text.slice(0, s) + text.slice(s, e).replace(/[^\n]/g, " ") + text.slice(e);

export interface ShTrap { start: number; end: number; text: string }
/** Команды trap (вне основного потока): их тексты и src, где они заменены пробелами. @throws ShParseError */
export function blankTraps(src: string): { text: string; traps: ShTrap[] } {
  const re = /(^|[;&|{(]|\bthen|\bdo|\belse)[ \t]*(trap)[ \t]/gm;
  const traps: ShTrap[] = [];
  let text = src;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const start = m.index + m[0].length - m[2].length - 1;
    const end = commandEnd(src, start);
    traps.push({ start, end, text: src.slice(start, end) });
    text = blank(text, start, end);
    re.lastIndex = Math.max(end, re.lastIndex);
  }
  return { text, traps };
}
