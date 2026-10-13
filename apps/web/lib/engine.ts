/**
 * Серверная обёртка над движком: единственная точка входа build() (инвариант 1) + кэш 15 минут
 * (равен задержке ISS), общий для страницы /check, чата и /api/report, + офлайн-режим на golden-снимках для тестов без сети (SO_OFFLINE=1).
 * Прямая форма, инструменты ассистента и Jev-гейт ходят только сюда. Сбой Мосбиржи buildCached отдаёт конвертом {kind:"err"}.
 */
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { build } from "@so/engine";
import type { BuildResultT, ReportInputs } from "@so/engine/contract";
import { applyInputs, needsRebuild } from "@so/engine/inputs";

const TTL_MS = 15 * 60_000;
const OFFLINE = process.env.SO_OFFLINE === "1";
const GOLDEN = path.resolve(process.cwd(), "../../packages/engine/golden");

interface Case { name: string; query: string; todayIso?: string }
let cases: { todayIso: string; cases: Case[] } | null = null;
function goldenCases() {
  cases ??= JSON.parse(fs.readFileSync(path.join(GOLDEN, "cases.json"), "utf8"));
  return cases!;
}

/** Офлайн: запрос → папка снимка. Совпадение по запросу кейса, ISIN/SECID/названию из эталона. */
function snapshotFor(query: string): { dir: string; todayIso: string; query: string } | null {
  const g = goldenCases();
  const q = query.trim().toLowerCase();
  for (const c of g.cases) {
    const found = { dir: path.join(GOLDEN, "snapshots", c.name), todayIso: c.todayIso ?? g.todayIso, query: c.query };
    if (c.query.toLowerCase() === q) return found;
    const exp = JSON.parse(fs.readFileSync(path.join(GOLDEN, "expected", c.name + ".json"), "utf8"));
    if (exp.kind === "report") {
      const s = exp.report.security;
      // снимок снят по запросу кейса — движок запускаем с ним, иначе поиска по имени в снимке нет
      if ([s.secid, s.isin, s.shortname, s.regnumber].filter(Boolean).some((v: string) => v.toLowerCase() === q)) return found;
    }
  }
  return null;
}

/* ───── кэш базовых результатов: ключ = запрос + цена предложения (остальной ввод — applyInputs) ─────
 * Хранилище — на globalThis, а не в модуле: Next собирает страницу /check и обработчики /api/* в разные бандлы,
 * у каждого свой экземпляр этого модуля, а процесс сервера один. Так отчёт, собранный страницей, видят чат и /api/report.
 * Одновременные сборки одного ключа делят один промис (inflight) — бумага не собирается из ISS дважды. */
interface ReportStore {
  cache: Map<string, { at: number; res: BuildResultT }>;
  inflight: Map<string, Promise<BuildResultT>>;
}
const STORE_KEY = Symbol.for("so.web.reportCache.v1");
function store(): ReportStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: ReportStore };
  return (g[STORE_KEY] ??= { cache: new Map(), inflight: new Map() });
}
/** Потолок записей: боты перебирают q, без него карта растёт без предела. Сначала уходят просроченные, потом самые старые. */
const CACHE_MAX = 500;
function remember(s: ReportStore, key: string, res: BuildResultT) {
  s.cache.delete(key); // свежая запись — в конец порядка вставки
  s.cache.set(key, { at: Date.now(), res });
  if (s.cache.size <= CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of s.cache) if (now - v.at >= TTL_MS) s.cache.delete(k);
  for (const k of s.cache.keys()) {
    if (s.cache.size <= CACHE_MAX) break;
    s.cache.delete(k);
  }
}
const keyOf = (query: string, offer: number | null | undefined) => `${query.trim().toLowerCase()}|${offer ?? ""}`;

/** Сбой Мосбиржи — IssError движка (сеть, HTTP, блокировка, неожиданный ответ). Класс пакетом движка не экспортируется,
 *  поэтому узнаём его по полю kind (от минификации имён классов это не зависит). */
const ISS_ERROR_KINDS = new Set(["network", "http", "blocked", "shape"]);
const isIssError = (e: unknown): boolean =>
  e instanceof Error && ISS_ERROR_KINDS.has(String((e as { kind?: unknown }).kind));
export const ISS_DOWN_MSG = "Мосбиржа сейчас не отвечает — попробуйте через минуту.";

async function buildBase(query: string, offer: number | null): Promise<{ res: BuildResultT; cacheable: boolean }> {
  const baseInputs: ReportInputs = { offer_price_pct: offer };
  if (OFFLINE) {
    const snap = snapshotFor(query);
    if (!snap) return { res: { kind: "notfound", query, isinValid: /^(RU|SU)[0-9A-Z]{10}$/i.test(query.trim()) }, cacheable: false };
    return { res: await build(snap.query, baseInputs, { fromSnapshotDir: snap.dir, todayIso: snap.todayIso }), cacheable: true };
  }
  return { res: await build(query, baseInputs), cacheable: true };
}

/** Базовый результат из кэша или одна общая сборка на ключ. Сбой ISS — исключение, в кэш не пишется. */
async function cachedBase(query: string, offer: number | null | undefined): Promise<BuildResultT> {
  const s = store();
  const key = keyOf(query, offer);
  const hit = s.cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.res;
  let p = s.inflight.get(key);
  if (!p) {
    p = buildBase(query, offer ?? null)
      .then(({ res, cacheable }) => {
        if (cacheable) remember(s, key, res);
        return res;
      })
      .finally(() => s.inflight.delete(key));
    s.inflight.set(key, p);
  }
  return p;
}

/** position / k / promised — та же функция движка, что и на странице */
const withInputs = (base: BuildResultT, inputs: ReportInputs): BuildResultT =>
  base.kind === "report" ? { kind: "report", report: applyInputs(base.report, inputs) } : base;

export async function buildCached(query: string, inputs: ReportInputs = {}): Promise<BuildResultT> {
  let base: BuildResultT;
  try {
    base = await cachedBase(query, inputs.offer_price_pct);
  } catch (e) {
    // Мосбиржа не ответила — понятный конверт ошибки вместо голого 500. В кэш сбой не пишется: следующий запрос пробует снова
    if (isIssError(e)) return { kind: "err", query, msg: ISS_DOWN_MSG };
    throw e;
  }
  return withInputs(base, inputs);
}

/** Пересчёт по новому вводу: без ISS, если менялись только позиция / комиссия / «обещали».
 *  Сбой ISS здесь — исключение, как раньше, а не конверт err: чат сохраняет результат пересчёта как текущий отчёт сессии
 *  (gate.ts change, tools.ts set_inputs), и конверт ошибки затёр бы уже собранный отчёт. */
export async function rebuild(
  query: string, current: BuildResultT, inputs: ReportInputs,
): Promise<BuildResultT> {
  if (current.kind === "report" && !needsRebuild(current.report, inputs))
    return { kind: "report", report: applyInputs(current.report, inputs) };
  const merged: ReportInputs = current.kind === "report"
    ? { ...current.report.inputs, ...inputs }
    : inputs;
  return withInputs(await cachedBase(query, merged.offer_price_pct), merged);
}

export const isOffline = () => OFFLINE;
