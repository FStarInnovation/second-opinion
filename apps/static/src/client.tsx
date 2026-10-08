/**
 * Клиентская точка входа статической страницы: гидратация SSR-разметки.
 * Шаблон без фактов: всё о бумаге приходит из <script id="so-data"> (паттерн const DATA из uw-dashboard).
 */
import { hydrateRoot } from "react-dom/client";
import { ResultApp } from "@so/blocks";
import type { PageData } from "./page";

const el = document.getElementById("so-data");
const root = document.getElementById("root");
if (el && root) {
  const data = JSON.parse(el.textContent || "{}") as PageData;
  hydrateRoot(
    root,
    <ResultApp result={data.result} homeHref={data.home} hrefFor={(secid) => data.links[secid] ?? null} />,
  );
}
