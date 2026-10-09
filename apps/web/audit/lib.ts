/**
 * Аудит-харнес ассистентного слоя (apps/web). Тот же контракт, что в packages/engine/src/audit/lib.ts.
 * Проверки — чистые функции (jev.ts, digest.ts, inputs) и статические проверки исходников там,
 * где поведение нельзя вызвать без сервера (route.ts, Caddyfile).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Kind = "unit" | "fixture" | "live" | "static";
export type Status = "GREEN" | "RED" | "ERROR" | "SKIP";
export interface Verdict { pass: boolean; detail: string }
export interface Check { id: string; title: string; wp: string; kind: Kind; guard?: boolean; run: () => Promise<Verdict> | Verdict }

export const pass = (detail: string): Verdict => ({ pass: true, detail });
export const fail = (detail: string): Verdict => ({ pass: false, detail });
export const expect = (cond: boolean, detail: string): Verdict => (cond ? pass(detail) : fail(detail));
export const approx = (a: number | null | undefined, b: number | null | undefined, tol: number) =>
  a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(WEB_ROOT, "..", "..");
export const LIVE = process.env.AUDIT_LIVE === "1";
export const readSrc = (relFromRepoRoot: string) => fs.readFileSync(path.join(REPO_ROOT, relFromRepoRoot), "utf8");
export const readJson = <T = unknown>(relFromRepoRoot: string): T => JSON.parse(readSrc(relFromRepoRoot)) as T;
/** Живой отчёт прода, сохранённый при аудите (для проверок digest/applyInputs без сети) */
export const AUDIT_FIXTURES = path.join(REPO_ROOT, "apps", "web", "audit", "fixtures");
export const fixture = <T = unknown>(name: string): T => JSON.parse(fs.readFileSync(path.join(AUDIT_FIXTURES, name), "utf8")) as T;
