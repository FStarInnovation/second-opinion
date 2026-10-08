/**
 * Серверная обёртка над движком: единственная точка входа build() (инвариант 1) + кэш 15 минут
 * (равен задержке ISS) + офлайн-режим на golden-снимках для тестов без сети (SO_OFFLINE=1).
 * Прямая форма, инструменты ассистента и Jev-гейт ходят только сюда.
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

interface Case { name: string; query: string }
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
    const found = { dir: path.join(GOLDEN, "snapshots", c.name), todayIso: g.todayIso, query: c.query };
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

/* ───── кэш базовых результатов: ключ = запрос + цена предложения (остальной ввод — applyInputs) ───── */
const cache = new Map<string, { at: number; res: BuildResultT }>();
const keyOf = (query: string, offer: number | null | undefined) => `${query.trim().toLowerCase()}|${offer ?? ""}`;

export async function buildCached(query: string, inputs: ReportInputs = {}): Promise<BuildResultT> {
  const key = keyOf(query, inputs.offer_price_pct);
  const hit = cache.get(key);
  let base: BuildResultT;
  if (hit && Date.now() - hit.at < TTL_MS) base = hit.res;
  else {
    const baseInputs: ReportInputs = { offer_price_pct: inputs.offer_price_pct ?? null };
    if (OFFLINE) {
      const snap = snapshotFor(query);
      if (!snap) return { kind: "notfound", query, isinValid: /^(RU|SU)[0-9A-Z]{10}$/i.test(query.trim()) };
      base = await build(snap.query, baseInputs, { fromSnapshotDir: snap.dir, todayIso: snap.todayIso });
    } else {
      base = await build(query, baseInputs);
    }
    cache.set(key, { at: Date.now(), res: base });
  }
  if (base.kind !== "report") return base;
  // position / k / promised — та же функция движка, что и на странице
  return { kind: "report", report: applyInputs(base.report, inputs) };
}

/** Пересчёт по новому вводу: без ISS, если менялись только позиция / комиссия / «обещали». */
export async function rebuild(
  query: string, current: BuildResultT, inputs: ReportInputs,
): Promise<BuildResultT> {
  if (current.kind === "report" && !needsRebuild(current.report, inputs))
    return { kind: "report", report: applyInputs(current.report, inputs) };
  const merged: ReportInputs = current.kind === "report"
    ? { ...current.report.inputs, ...inputs }
    : inputs;
  return buildCached(query, merged);
}

export const isOffline = () => OFFLINE;
