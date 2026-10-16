/**
 * Telegram-HTML (план WP-TG §4.7): разрешены только теги b, i, code, a; `&`, `<`, `>` (и `"`) экранированы сущностями.
 * Видимая длина — как её считает Telegram: текст после разбора тегов и сущностей, в единицах UTF-16; предел сообщения 4096.
 */

/** Именованные сущности, которые понимает Bot API (и apos/nbsp — на случай чужого текста) */
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
const TAG_RE = /<[^>]*>/g;
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;
/** Предел длины сообщения Bot API */
export const TG_MAX = 4096;

/** Экранирование текста для parse_mode HTML */
export function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Тот же текст без разметки: теги сняты (на пустую строку), сущности раскодированы — для отката на простой текст */
export function htmlToPlain(h: string): string {
  return decodeEntities(String(h).replace(TAG_RE, ""));
}

/** Длина после разбора тегов и сущностей (UTF-16) — как считает Telegram */
export function visibleLength(h: string): number {
  return htmlToPlain(h).length;
}

/* ───── деление длинного HTML ───── */

/** Единица деления: кусок HTML и разделитель перед ним; hard — кусок резался посреди строки и идёт отдельным сообщением */
interface Unit { html: string; sep: string; hard?: boolean }

const tagName = (t: string) => (/^<\/?\s*([A-Za-z0-9]+)/.exec(t)?.[1] ?? "").toLowerCase();

/** Одна строка длиннее max: режется по видимым символам (тег и сущность не режутся); открытые теги закрываются в конце части и
 *  открываются заново в начале следующей. По возможности — по пробелу. */
function hardSplit(line: string, max: number): string[] {
  const toks = line.match(/<[^>]*>|&(?:#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);|[\s\S]/gu) ?? [];
  const parts: string[] = [];
  const open: string[] = [];
  let cur: string[] = [];
  let len = 0;
  /** позиция в cur после последнего пробела (для деления по пробелу) и длина до неё; открытые теги на тот момент */
  let lastSpace = -1, lenAtSpace = 0, openAtSpace: string[] = [];
  const close = (stack: readonly string[]) => [...stack].reverse().map((t) => `</${tagName(t)}>`).join("");
  const cut = (at: number, atLen: number, stack: string[]) => {
    const head = cur.slice(0, at).join("") + close(stack);
    const tail = cur.slice(at);
    parts.push(head);
    cur = [...stack, ...tail];
    len -= atLen;
    lastSpace = -1;
  };
  for (const t of toks) {
    if (t.length > 1 && t.startsWith("<") && t.endsWith(">")) {
      if (t.startsWith("</")) open.pop(); else open.push(t);
      cur.push(t);
      continue;
    }
    const w = t.length > 1 && t.startsWith("&") ? decodeEntities(t).length : t.length;
    if (len + w > max && len > 0) {
      if (lastSpace > 0 && lenAtSpace > max / 2) cut(lastSpace, lenAtSpace, openAtSpace);
      else cut(cur.length, len, open.slice());
    }
    cur.push(t);
    len += w;
    if (/^\s$/.test(t)) { lastSpace = cur.length; lenAtSpace = len; openAtSpace = open.slice(); }
  }
  if (cur.length) parts.push(cur.join("") + close(open));
  return parts.filter((p) => htmlToPlain(p).trim() !== "");
}

/**
 * Деление HTML на сообщения не длиннее max видимых символов: по границам секций (пустая строка), затем по строкам; строка
 * длиннее max режется посреди с переоткрытием тегов. Теги внутри строки сбалансированы — граница строки тег не режет.
 * Короткий HTML — одним сообщением как есть.
 */
export function splitHtml(h: string, max: number = TG_MAX): string[] {
  const src = String(h);
  if (visibleLength(src) <= max) return [src];
  const units: Unit[] = [];
  src.split(/\n{2,}/).forEach((block, bi) => {
    const bsep = bi ? "\n\n" : "";
    if (visibleLength(block) <= max) { units.push({ html: block, sep: bsep }); return; }
    block.split("\n").forEach((line, li) => {
      const sep = li ? "\n" : bsep;
      if (visibleLength(line) <= max) { units.push({ html: line, sep }); return; }
      for (const p of hardSplit(line, max)) units.push({ html: p, sep, hard: true });
    });
  });
  const out: string[] = [];
  let cur = "";
  const flush = () => { if (htmlToPlain(cur).trim() !== "") out.push(cur); cur = ""; };
  for (const u of units) {
    if (u.hard) { flush(); out.push(u.html); continue; }
    if (cur === "") { cur = u.html; continue; }
    const next = cur + u.sep + u.html;
    if (visibleLength(next) <= max) cur = next;
    else { flush(); cur = u.html; }
  }
  flush();
  return out.length ? out : [src];
}
