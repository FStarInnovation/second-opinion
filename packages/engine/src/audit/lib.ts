/**
 * Аудит-харнес движка: общий API проверок и фикстуры.
 * См. docs/AUDIT_PLAN_2026-10-09.md («Харнес: соглашения»).
 *
 * Каждая проверка утверждает ЖЕЛАЕМОЕ поведение (после правки). До правки она RED — это норма.
 * Проверка, которая GREEN до правки, — дефект харнеса, а не победа.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../build";
import type { BondFacts, CouponRow } from "../iss/facts";
import type { BondReportT, BuildResultT, ReportInputs } from "../contract";

export type Kind = "unit" | "fixture" | "live" | "static";
export type Status = "GREEN" | "RED" | "ERROR" | "SKIP";

export interface Verdict {
  pass: boolean;
  /** Факты: числа, поля, цитаты — чтобы по RED было видно, ЧТО именно не так */
  detail: string;
}

export interface Check {
  /** Идентификатор из плана: «B.1», «H.4», … */
  id: string;
  title: string;
  /** Пакет работ: A, B, C, D, F, G, R, H, S, T */
  wp: string;
  kind: Kind;
  /** guard = инвариант, который должен быть GREEN уже сейчас (защита от регрессии при правках) */
  guard?: boolean;
  run: () => Promise<Verdict> | Verdict;
}

export const pass = (detail: string): Verdict => ({ pass: true, detail });
export const fail = (detail: string): Verdict => ({ pass: false, detail });
export const expect = (cond: boolean, detail: string): Verdict => (cond ? pass(detail) : fail(detail));
export const approx = (a: number | null | undefined, b: number | null | undefined, tol: number) =>
  a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/* ───── пути ───── */
const here = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_ROOT = path.resolve(here, "..", "..");
export const REPO_ROOT = path.resolve(ENGINE_ROOT, "..", "..");
export const GOLDEN_DIR = path.join(ENGINE_ROOT, "golden");
/** Снимки ISS для харнеса — ОТДЕЛЬНО от golden (golden нельзя пополнять до исправления дефекта) */
export const FIXTURES_DIR = path.join(ENGINE_ROOT, "audit-fixtures");
export const LIVE = process.env.AUDIT_LIVE === "1";

export function readSrc(relFromRepoRoot: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relFromRepoRoot), "utf8");
}

/* ───── golden и фикстуры ───── */
interface CasesFile { todayIso: string; cases: { name: string; query: string; inputs: Record<string, number>; todayIso?: string }[] }
export function goldenCases(): CasesFile {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, "cases.json"), "utf8"));
}
/** Собрать golden-кейс из замороженного снимка (как selftest). inputs/todayIso можно переопределить. */
export async function buildGolden(name: string, over: { inputs?: ReportInputs; todayIso?: string } = {}): Promise<BuildResultT> {
  const meta = goldenCases();
  const c = meta.cases.find((x) => x.name === name);
  if (!c) throw new Error(`golden-кейс «${name}» не найден в cases.json`);
  return build(c.query, { ...(c.inputs as ReportInputs), ...(over.inputs ?? {}) }, {
    fromSnapshotDir: path.join(GOLDEN_DIR, "snapshots", name),
    todayIso: over.todayIso ?? c.todayIso ?? meta.todayIso,
  });
}
/** Снимок ISS для харнеса: читает audit-fixtures/<name>/ (meta.json хранит query/todayIso).
 *  Если снимка нет и AUDIT_LIVE=1 — снимет его с живого ISS и сохранит. */
export async function buildFixture(name: string, over: { inputs?: ReportInputs; todayIso?: string } = {}): Promise<BuildResultT> {
  const dir = path.join(FIXTURES_DIR, name);
  const metaFile = path.join(dir, "meta.json");
  if (!fs.existsSync(metaFile)) throw new Error(`фикстура «${name}» не снята: нет ${metaFile}. Снять: AUDIT_LIVE=1 и captureFixture()`);
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as { query: string; todayIso: string; inputs?: ReportInputs };
  return build(meta.query, { ...(meta.inputs ?? {}), ...(over.inputs ?? {}) }, {
    fromSnapshotDir: dir,
    todayIso: over.todayIso ?? meta.todayIso,
  });
}
/** Снять снимок ISS в audit-fixtures/<name>/ (только с живой сетью). Возвращает результат живой сборки. */
export async function captureFixture(name: string, query: string, inputs: ReportInputs = {}, todayIso?: string): Promise<BuildResultT> {
  const dir = path.join(FIXTURES_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const today = todayIso ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10); // МСК
  const res = await build(query, inputs, { snapshotDir: dir, todayIso: today });
  fs.writeFileSync(metaPath(name), JSON.stringify({ query, todayIso: today, inputs, captured_at: new Date().toISOString() }, null, 2));
  return res;
}
export const metaPath = (name: string) => path.join(FIXTURES_DIR, name, "meta.json");
export const hasFixture = (name: string) => fs.existsSync(metaPath(name));

/** Прочитать таблицу из снимка (golden или фикстуры) — для сравнения с «сырыми» полями ISS */
export function snapshotRows(dir: string, fileSubstr: string, table: string): Record<string, unknown>[] {
  const f = fs.readdirSync(dir).find((x) => x.includes(fileSubstr));
  if (!f) throw new Error(`в ${dir} нет файла снимка, содержащего «${fileSubstr}»`);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, { columns: string[]; data: unknown[][] }>;
  const t = doc[table];
  if (!t) throw new Error(`в ${f} нет таблицы ${table}`);
  return t.data.map((row) => Object.fromEntries(t.columns.map((c, i) => [c, row[i]])));
}

export function reportOf(res: BuildResultT): BondReportT {
  if (res.kind !== "report") throw new Error(`ожидался отчёт, получено kind=${res.kind}`);
  return res.report;
}

/* ───── синтетические факты ───── */
const yearsFrom = (todayIso: string, iso: string) => (Date.parse(iso) - Date.parse(todayIso)) / 86_400_000 / 365;
const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10);

/** Купонный ряд: n купонов каждые periodDays от today; value — число, null (не опубликован) или функция от индекса */
export function coupons(todayIso: string, n: number, periodDays: number, value: number | null | ((i: number) => number | null), startOffsetDays = periodDays): CouponRow[] {
  const out: CouponRow[] = [];
  for (let i = 0; i < n; i++) {
    const dateIso = addDays(todayIso, startOffsetDays + i * periodDays);
    const v = typeof value === "function" ? value(i) : value;
    out.push({ dateIso, t: yearsFrom(todayIso, dateIso), value: v, valueprc: null, future: true });
  }
  return out;
}

/** Базовая синтетическая бумага: фикс. купон 12%, номинал 1000, цена 100, 2 года, полугодовой купон, ликвидная, без оферты. */
export function facts(over: Partial<BondFacts> = {}): BondFacts {
  const todayIso = over.todayIso ?? "2026-10-09";
  const matIso = over.matIso ?? addDays(todayIso, 730);
  const base: BondFacts = {
    secid: "SYNTH", isin: "RU000SYNTH00", boardid: "TQCB", shortname: "Синтетика", secname: "Синтетическая облигация", regnumber: null,
    emit: "ООО Синтетика", kind: "Корпоративная облигация", todayIso, settleIso: todayIso,
    face: 1000, fu: "SUR", acc: 0, cp: 12, period: 182, matIso, daysMat: Math.round(yearsFrom(todayIso, matIso) * 365),
    nextCouponIso: addDays(todayIso, 182),
    ctype: "fixed", r0: null,
    coupons: coupons(todayIso, 4, 182, 1000 * 0.12 * 182 / 365),
    amortFuture: [], amortized: false,
    offerKind: "none", offerDateIso: null, offerPrice: null, offerPriceAssumedPar: false, reset: false,
    wap: 100, prevWap: 100, bid: 99.9, offerQ: 100.1, upd: "12:00:00", tradeDateIso: todayIso,
    moexY: null, moexYPrice: null, moexYDatetype: null, g: 200, durDays: 650,
    stop: false, structured: false, subordinated: false, perpetual: false, lvl: 2, qual: false, hasDefault: false,
    avg: 50_000_000, avgNT: 500, nDays: 20,
  };
  return { ...base, ...over };
}

/** Эталонный IRR по явным потокам (независимо от движка): P сегодня, потоки [t лет, сумма] → % годовых (эффективная) */
export function irr(P: number, flows: [number, number][]): number | null {
  const pv = (y: number) => flows.reduce((s, [t, cf]) => s + cf / Math.pow(1 + y, t), 0);
  let lo = -0.9, hi = 3;
  if ((pv(lo) - P) * (pv(hi) - P) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > P) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) * 100;
}

export const fmt = (x: number | null | undefined, d = 2) => (x == null ? "null" : x.toFixed(d));
