import { isValidElement, type ReactNode } from "react";

/** Теги, после которых текст идёт с новой строки */
const BLOCK = new Set(["p", "div", "ul", "ol", "li", "section", "h1", "h2", "h3", "h4", "br"]);

/**
 * Видимый текст дерева React без рендера — для FAQPage JSON-LD и /llms.txt из тех же пунктов FAQ, что рисует главная.
 * Строки и числа — как есть, абзацы — с новой строки, пункт списка — «- …»; пробелы внутри строки схлопываются.
 * Рассчитано на статичную разметку (p, ul, li, b, фрагменты): компоненты-функции не вызываются — берутся их children.
 */
export function nodeText(node: ReactNode): string {
  return walk(node)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function walk(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const inner = walk(node.props.children);
    if (node.type === "li") return `\n- ${inner}\n`;
    return typeof node.type === "string" && BLOCK.has(node.type) ? `\n${inner}\n` : inner;
  }
  if (typeof node === "object" && Symbol.iterator in node) return Array.from(node as Iterable<ReactNode>, walk).join("");
  return ""; // промис (асинхронный узел) и прочее — не текст
}
