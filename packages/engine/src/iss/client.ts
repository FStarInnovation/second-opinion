/**
 * Клиент MOEX ISS: запросы №1–№4 + поиск (нумерация — из сводной постановки).
 * Правила, проверенные на живом ISS 08.10.2026:
 *  - №3 bondization без limit=1000 обрезает график на 20 строках;
 *  - №4 history без from/till отдаёт старейшие записи — окно дат обязательно (П13);
 *  - №2 description отдаёт значения строками — приводим к числам до арифметики.
 * Классификация ошибок — по образцу uw-dashboard (403: блок по пути, не auth).
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "https://iss.moex.com";

/* Прокси-окружение (например, песочница разработки): HTTPS_PROXY + свой CA.
 * На обычном хосте без HTTPS_PROXY используется прямой fetch. */
let dispatcherReady: Promise<void> | null = null;
function ensureDispatcher(): Promise<void> {
  if (dispatcherReady) return dispatcherReady;
  dispatcherReady = (async () => {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!proxy) return;
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    // CA прокси песочницы: путь только из окружения (бандлеру не нужно трассировать весь диск)
    const caPath = process.env.NODE_EXTRA_CA_CERTS || "/root/.ccr/ca-bundle.crt";
    const ca = fs.existsSync(/*turbopackIgnore: true*/ caPath) ? fs.readFileSync(/*turbopackIgnore: true*/ caPath, "utf8") : undefined;
    setGlobalDispatcher(
      new ProxyAgent({ uri: proxy, proxyTls: ca ? { ca } : undefined, requestTls: ca ? { ca } : undefined }),
    );
  })();
  return dispatcherReady;
}

export class IssError extends Error {
  constructor(
    public kind: "network" | "http" | "blocked" | "shape",
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export interface IssTable {
  columns: string[];
  data: unknown[][];
}
export type IssDoc = Record<string, IssTable>;

export interface FetchOptions {
  snapshotDir?: string; // куда писать сырые JSON (воспроизводимость)
  fromSnapshotDir?: string; // офлайн-режим: читать снимки вместо сети (selftest)
  retries?: number;
}

function slug(u: string): string {
  return u
    .replace(BASE + "/iss/", "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .slice(0, 150);
}

export async function issJson(url: string, opts: FetchOptions = {}): Promise<IssDoc> {
  const file = slug(url) + ".json";
  if (opts.fromSnapshotDir) {
    const p = path.join(opts.fromSnapshotDir, file);
    if (!fs.existsSync(p)) throw new IssError("network", `нет снимка: ${file}`);
    return JSON.parse(fs.readFileSync(p, "utf8")) as IssDoc;
  }
  await ensureDispatcher();
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (r.status === 403) throw new IssError("blocked", `ISS 403 (блокировка по сети/пути): ${url}`, 403);
      if (!r.ok) throw new IssError("http", `ISS HTTP ${r.status}: ${url}`, r.status);
      const doc = (await r.json()) as IssDoc;
      if (opts.snapshotDir) {
        fs.mkdirSync(opts.snapshotDir, { recursive: true });
        fs.writeFileSync(path.join(opts.snapshotDir, file), JSON.stringify(doc));
      }
      return doc;
    } catch (e) {
      lastErr = e;
      if (e instanceof IssError && e.kind === "blocked") throw e;
      if (i < retries) await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
  if (lastErr instanceof IssError) throw lastErr;
  throw new IssError("network", `ISS недоступен: ${url} (${String(lastErr)})`);
}

export function rows<T = Record<string, unknown>>(doc: IssDoc, table: string): T[] {
  const t = doc[table];
  if (!t) return [];
  return t.data.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])) as T);
}

/** №2 description отдаёт значения строками — числа приводим явно. */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

export function isoDateOrNull(v: unknown): string | null {
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s === "0000-00-00") return null; // П8: «0000-00-00» отбрасываем
  return s;
}

/* ───── запросы ───── */

export const q = {
  search: (text: string) =>
    `${BASE}/iss/securities.json?q=${encodeURIComponent(text)}&iss.meta=off`,
  n1: (boardid: string, secid: string) =>
    `${BASE}/iss/engines/stock/markets/bonds/boards/${boardid}/securities/${secid}.json?iss.meta=off`,
  n2: (secid: string) => `${BASE}/iss/securities/${secid}.json?iss.meta=off`,
  n3: (secid: string) =>
    `${BASE}/iss/securities/${secid}/bondization.json?iss.meta=off&limit=1000`,
  n4: (boardid: string, secid: string, from: string, till: string) =>
    `${BASE}/iss/history/engines/stock/markets/bonds/boards/${boardid}/securities/${secid}.json?iss.meta=off&from=${from}&till=${till}`,
};
