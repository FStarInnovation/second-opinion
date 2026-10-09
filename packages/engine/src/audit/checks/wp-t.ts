/**
 * WP-T — тесты и эталоны (docs/AUDIT_PLAN_2026-10-09.md, раздел WP-T; аудит R2-28, «golden/cases.json:5», §A/§C/§F).
 * Каждая проверка утверждает ЖЕЛАЕМОЕ поведение; до правки — RED, guard — GREEN уже сейчас.
 *
 *   T.1  selftest ловит синтетическое расхождение own/биржа > CONFIG.controlWarnPp (0,5 п.п.) ДАЖЕ после golden:write.
 *        R2-28: сегодня selftest — только снапшот-сравнение, «благословлённый» дефект проходит (SELFTEST OK).
 *        Механика: временная копия движка (весь src + golden + package.json; node_modules и audit-fixtures — симлинки на репо)
 *        → мутация → `tsx src/golden-update.ts --write` (эталоны переписаны под дефект) → `tsx src/selftest.ts`.
 *        Три независимые мутации, каждая в своей копии (все — на кейсе rolf, RU000A10ASE2):
 *          данные          — в снимке №1 golden/rolf биржевая доходность +3 п.п. (EFFECTIVEYIELDWAPRICE, YIELDATWAPRICE,
 *                            YIELDATPREVWAPRICE), own от той же цены не меняется → Δ ≈ 3,2; ловится инвариантом №1 плана
 *                            (control_diff_pp ≤ controlWarnPp) и №2 (fail при «контроль:» в warnings);
 *          код             — yieldOf × 1,05 (own уезжает на ~0,8 п.п., биржа стоит); ловится теми же №1/№2;
 *          код без контроля — yieldOf × 1,05 И report.ts перестаёт считать controlDiff (→ null): control_diff_pp = null,
 *                            предупреждение «контроль:» не пишется. Инварианты №1/№2 слепы; поймать можно только
 *                            сравнением own с EFFECTIVEYIELDWAPRICE снимка (инвариант №3 плана) — own 20,94 vs 20,16.
 *        Желаемое для каждого сценария: selftest exit ≠ 0, есть строки FAIL, и хотя бы одна из них называет кейс rolf.
 *        Расхождение измеряется НЕЗАВИСИМО от отчёта: own_control_pct благословлённого эталона против
 *        marketdata_yields.EFFECTIVEYIELDWAPRICE из снимка копии. Статика по selftest.ts — только информационно.
 *   T.2  golden покрывает 4 класса (буквы = пакеты работ): A — секьюритизация, купоны value=null ПОСЛЕ будущих частичных
 *        амортизаций; F — колл-бумага, которую биржа считает к коллу (YIELDDATETYPE=OFFER), колл не «скорый», цена ≠ цене колла;
 *        C — биржевая доходность ровно 0 при опубликованной цене (первая непустая в цепочке ISS); B — пятничный снимок РОЛЬФ
 *        (todayIso пятница, SETTLEDATE через выходные). Предикаты классов верифицируются на снимках audit-fixtures
 *        (sfo_ast0, tb9a / call_telhol / C_veb_zero0, C_veb_prev0 / rolf_friday): если ни один образец класса не найден
 *        (папка переименована/удалена) или предикат не узнаёт ни один свой образец — это ERROR харнеса, а не RED.
 *        Трактовка класса F: «биржа считает к коллу И цена ≠ цене колла» (|clean − колл| ≥ 0,25 в ЛЮБУЮ сторону), а не строго
 *        «с премией» из плана: дефект горизонта (own к погашению vs биржа к коллу) проявляется в обе стороны — call_telhol
 *        торгуется с ДИСКОНТОМ (clean 99,57 < 100), и всё же срабатывают оба правила WP-F (datetype OFFER; call.y 16,88 < main 17,22);
 *        F.2 (min → call) покрыт синтетикой wp-f. Граница «не скорый» строгая: days_to > callSoonDays — ровно callSoonDays
 *        есть зона неоднозначности «<» vs «<=», которую G.6 признаёт дефектом, такой образец классу не засчитывается.
 *   T.3* `npm run -s -w @so/engine selftest` зелёный (guard).
 *   T.4* все эталоны golden проходят BuildResult.parse (report — и BondReport.parse), у каждого кейса есть снимок,
 *        snapshot_dir относительный, эталонов-сирот нет (guard).
 *   T.5  `npm run check` включает аудит-харнес, и отказ ЛЮБОГО раннера (движок packages/engine, веб apps/web; RED/ERROR → exit 1)
 *        доходит до exit-кода `npm run check`. Статика по package.json: мини-модель sh исполняет scripts.check четыре раза
 *        (раннеры зелёные / падает движок / падает веб / падают оба) и смотрит итоговый exit-код — а не ищет подстроки.
 *        Модель понимает: «;», «&&», «||», переносы строк, `X=$?` / `X=1` / `export X=…`, префикс окружения `K=V cmd`,
 *        `exit [N | $X | ${X:-d} | $? | $((…))]` (арифметика: | || & && + − * ! == != и скобки), `[ … ]`/`[[ … ]]`/`test`
 *        (-eq -ne -gt -ge -lt -le = == != -n -z), `! cmd`, `true/false/:`, `set -e`/`set +e`, `sh|bash -c '…'`,
 *        `run-s`/`npm-run-all`/`concurrently` (любой отказ → ненулевой), `npm run <script>` по scripts корня (рекурсивно,
 *        каждый скрипт — отдельный процесс), раннеры в формах `npm run [-s] -w|--workspace[=]@so/engine|packages/engine audit`
 *        (флаги в любом порядке, также `--prefix`, `-ws`), `npm run audit:engine|audit:web`, `… packages/engine/src/audit/harness`,
 *        `… apps/web/audit/harness`. Любая другая команда считается успешной (exit 0).
 *        НЕ распознаёт (→ RED «проброс не подтверждён», а не GREEN): конвейеры «|», фон «&», подоболочки «( )»/«{ }»,
 *        `$(…)`/обратные кавычки, if/for/while/case, cd, eval/exec/source, pnpm/yarn, concurrently --success/--race,
 *        «;» и операторы внутри кавычек не разбираются (кроме `sh -c`), неизвестные флаги npm с аргументом перед `run`.
 *        Дополнительно (соглашение харнеса «`npm run audit` → exit 1 при любом RED/ERROR»): если check НЕ идёт через
 *        `npm run audit`, scripts.audit моделируется отдельно — глотание отказа раннера в нём тоже RED.
 *        Флаги самого раннера (`--baseline`, `--only`, `--json`) не интерпретируются: моделируется только проброс его кода возврата
 *        (раннер с `--baseline` сам даёт exit 1 лишь при ухудшении против baseline — это свойство раннера, не скрипта check).
 *        Модель самопроверяется на ~36 синтетических package.json (в т.ч. `A; E=$?; B; exit $E`, `A; B; true; X=$?; exit $X`,
 *        `A; B; exit $?` — ОБЯЗАНЫ быть признаны глотающими; `( … )`, `&`, `$((X>Y?X:Y))` — «не распознано») — расхождение = ERROR харнеса.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ENGINE_ROOT, FIXTURES_DIR, GOLDEN_DIR, REPO_ROOT, buildFixture, expect, fmt, goldenCases, hasFixture, readSrc, reportOf,
  type Check, type Verdict,
} from "../lib";
import { BondReport, BuildResult, type BondReportT } from "../../contract";
import { CONFIG } from "../../config";
import { toNum } from "../../iss/client";

/* ───── общее ───── */
interface Block { name: string; problems: string[]; facts: string }
const verdict = (blocks: Block[]): Verdict => ({
  pass: blocks.every((b) => b.problems.length === 0),
  detail: blocks
    .map((b) => `[${b.name}] ${b.problems.length ? "НЕ ВЫПОЛНЕНО: " + b.problems.join("; ") + " | " : "ок | "}${b.facts}`)
    .join("\n"),
});

type Table = { columns: string[]; data: unknown[][] };
type Doc = Record<string, Table>;
const N1 = (f: string) => f.startsWith("engines_stock_markets_bonds_boards_"); // №1: securities / marketdata / marketdata_yields
const N3 = (f: string) => f.includes("bondization"); // №3: coupons / amortizations / offers

function readDoc(dir: string, pick: (f: string) => boolean, what: string): Doc {
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".json") && pick(x));
  if (!f) throw new Error(`в ${dir} нет снимка ${what}`);
  return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Doc;
}
function rowsOf(doc: Doc, table: string): Record<string, unknown>[] {
  const t = doc[table];
  if (!t) return [];
  return t.data.map((row) => Object.fromEntries(t.columns.map((c, i) => [c, row[i]])));
}
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const dmyToIso = (d: string | null): string | null =>
  d && /^\d{2}\.\d{2}\.\d{4}$/.test(d) ? `${d.slice(6)}-${d.slice(3, 5)}-${d.slice(0, 2)}` : null;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const DOW = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const dow = (iso: string) => new Date(iso + "T00:00:00Z").getUTCDay();

/* ───── процессы ───── */
const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
interface Run { status: number | null; stdout: string; stderr: string }
function tsx(cwd: string, script: string, args: string[] = []): Run {
  const r = spawnSync(tsxBin, [script, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000, env: { ...process.env } });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const failLines = (stdout: string) => stdout.split("\n").filter((l) => l.startsWith("FAIL"));
const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop() ?? "";

/* ───── T.1: временная копия движка ───── */
/** Копия = весь src (включая audit/, чтобы будущий selftest мог переиспользовать audit/lib.ts) + golden + package.json/tsconfig;
 *  node_modules и audit-fixtures — симлинки на репо (только чтение). */
function engineCopy(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `so-audit-T1-${tag}-`));
  fs.cpSync(path.join(ENGINE_ROOT, "src"), path.join(dir, "src"), { recursive: true });
  fs.cpSync(GOLDEN_DIR, path.join(dir, "golden"), { recursive: true });
  for (const f of ["package.json", "tsconfig.json"])
    if (fs.existsSync(path.join(ENGINE_ROOT, f))) fs.copyFileSync(path.join(ENGINE_ROOT, f), path.join(dir, f));
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
  if (fs.existsSync(FIXTURES_DIR)) fs.symlinkSync(FIXTURES_DIR, path.join(dir, "audit-fixtures"), "dir");
  return dir;
}
function dropCopy(dir: string): void {
  for (const link of ["node_modules", "audit-fixtures"])
    try { fs.unlinkSync(path.join(dir, link)); } catch { /* симлинка нет или уже снят */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}

/** Единственное вхождение якоря в файле копии заменяется; иначе — дефект харнеса (якорь устарел) */
function replaceOnce(copy: string, rel: string, anchor: string, replacement: string, tag: string): void {
  const file = path.join(copy, "src", rel);
  const s = fs.readFileSync(file, "utf8");
  const n = s.split(anchor).length - 1;
  if (n !== 1) throw new Error(`${rel}: якорь «${anchor}» встречается ${n} раз — мутация T.1(${tag}) неприменима, обнови якорь в wp-t.ts`);
  fs.writeFileSync(file, s.replace(anchor, replacement));
}

/** Мутация «данные»: биржевая доходность в снимке №1 кейса сдвигается на deltaPp (все три поля цепочки), цена не меняется */
function bumpExchangeYield(copy: string, caseName: string, deltaPp: number): string {
  const dir = path.join(copy, "golden", "snapshots", caseName);
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".json") && N1(x));
  if (!f) throw new Error(`в ${dir} нет снимка №1`);
  const file = path.join(dir, f);
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as Doc;
  const notes: string[] = [];
  for (const [table, col] of [
    ["marketdata_yields", "EFFECTIVEYIELDWAPRICE"],
    ["marketdata", "YIELDATWAPRICE"],
    ["securities", "YIELDATPREVWAPRICE"],
  ] as const) {
    const t = doc[table];
    const i = t?.columns.indexOf(col) ?? -1;
    if (!t || i < 0 || !t.data[0]) { notes.push(`${table}.${col}: поля нет`); continue; }
    const v = toNum(t.data[0][i]);
    if (v == null) { notes.push(`${table}.${col}=null`); continue; }
    const nv = Math.round((v + deltaPp) * 10_000) / 10_000;
    t.data[0][i] = nv;
    notes.push(`${table}.${col} ${v}→${nv}`);
  }
  fs.writeFileSync(file, JSON.stringify(doc));
  return `снимок ${caseName}: ${notes.join(", ")}`;
}

/** Мутация «код»: yieldOf × factor (own и всё производное уезжают, биржевая доходность и юнит-тесты solve/shift — нет) */
function mutateYieldOf(copy: string, factor: number): string {
  const anchor = "export function yieldOf(";
  replaceOnce(copy, "metrics.ts", anchor, "function yieldOf0(", "код");
  fs.appendFileSync(
    path.join(copy, "src", "metrics.ts"),
    `\n/* T.1: мутация аудит-харнеса */\nexport function yieldOf(...a: any[]): number | null { const y = (yieldOf0 as any)(...a); return y == null ? null : y * ${factor}; }\n`,
  );
  return `metrics.ts: yieldOf → yieldOf0 × ${factor}`;
}

/** Мутация «контроль отключён»: report.ts не считает controlDiff → control_diff_pp = null, предупреждение «контроль:» не пишется */
function mutateControlDiffNull(copy: string): string {
  const anchor = "round2(Math.abs(ownCtl - b.moexY))";
  replaceOnce(copy, "report.ts", anchor, "null /* T.1: контроль отключён */", "код без контроля");
  return `report.ts: ${anchor} → null`;
}

interface Scenario {
  name: string;
  probeCase: string;
  /** подстроки, по которым FAIL-строка «называет» кейс (имя кейса или его ISIN) */
  probeNames: string[];
  /** после мутации в эталоне ожидается control_diff_pp = null и отсутствие «контроль:» */
  ctlDisabled: boolean;
  mutate: (copy: string) => string[];
}

interface Blessed { own: number | null; exch: number | null; ctl: number | null; ctlWarns: number; status: string | null }
function blessedOf(copy: string, caseName: string): Blessed {
  const f = path.join(copy, "golden", "expected", caseName + ".json");
  if (!fs.existsSync(f)) throw new Error(`после golden:write нет эталона ${caseName} — дефект харнеса`);
  const e = JSON.parse(fs.readFileSync(f, "utf8")) as { kind: string; report?: BondReportT };
  if (e.kind !== "report" || !e.report) throw new Error(`эталон ${caseName} не отчёт (kind=${e.kind}) — дефект харнеса`);
  const r = e.report;
  return {
    own: r.yield.own_control_pct, exch: r.yield.exchange.pct, ctl: r.yield.control_diff_pp,
    ctlWarns: r.diagnostics.warnings.filter((w) => w.includes("контроль:")).length, status: r.status.kind,
  };
}
/** EFFECTIVEYIELDWAPRICE из снимка №1 копии — независимо от отчёта */
function snapshotExchangeYield(copy: string, caseName: string): number | null {
  const my = rowsOf(readDoc(path.join(copy, "golden", "snapshots", caseName), N1, "№1"), "marketdata_yields")[0] ?? {};
  return toNum(my.EFFECTIVEYIELDWAPRICE);
}

/** мутация → golden:write (благословление) → selftest; желаемое — selftest падает и называет кейс */
function runScenario(copy: string, sc: Scenario): Block {
  const problems: string[] = [];
  const mutation = sc.mutate(copy).join("; ");
  const bless = tsx(copy, "src/golden-update.ts", ["--write"]);
  if (bless.status !== 0) throw new Error(`T.1 ${sc.name}: golden:write в копии упал (exit ${bless.status}): ${lastLine(bless.stderr || bless.stdout).slice(0, 200)}`);
  const st = tsx(copy, "src/selftest.ts");
  const fails = failLines(st.stdout);
  const named = fails.filter((l) => sc.probeNames.some((n) => l.includes(n)));

  // что благословлено и каково расхождение НЕЗАВИСИМО от отчёта
  const b = blessedOf(copy, sc.probeCase);
  const snapY = snapshotExchangeYield(copy, sc.probeCase);
  const indep = b.own != null && snapY != null ? Math.round(Math.abs(b.own - snapY) * 100) / 100 : null;
  const W = CONFIG.controlWarnPp;

  // дефекты харнеса (мутация не сработала) — ERROR, не RED
  if (indep == null || indep <= W)
    throw new Error(`T.1 ${sc.name}: мутация не создала расхождения: own ${fmt(b.own)} vs EFFECTIVEYIELDWAPRICE снимка ${fmt(snapY, 4)} (Δ ${fmt(indep)} ≤ ${W}) — дефект харнеса`);
  if (sc.ctlDisabled && (b.ctl != null || b.ctlWarns > 0))
    throw new Error(`T.1 ${sc.name}: контроль должен быть отключён, но control_diff_pp ${fmt(b.ctl)}, «контроль:»-предупреждений ${b.ctlWarns} — дефект харнеса`);
  if (!sc.ctlDisabled && (b.ctl == null || b.ctl <= W))
    throw new Error(`T.1 ${sc.name}: ожидалось control_diff_pp > ${W} в эталоне, получено ${fmt(b.ctl)} — дефект харнеса`);
  if (b.status !== "ok") throw new Error(`T.1 ${sc.name}: эталон ${sc.probeCase} после мутации status ${b.status}, ожидался ok — дефект харнеса`);

  const where = `own_control ${fmt(b.own)} vs EFFECTIVEYIELDWAPRICE снимка ${fmt(snapY, 4)} (Δ ${fmt(indep)} п.п. > ${W}); в отчёте control_diff_pp ${fmt(b.ctl)}, «контроль:»-предупреждений ${b.ctlWarns}`;
  if (st.status === 0)
    problems.push(`selftest зелёный (exit 0, «${lastLine(st.stdout)}») при ${where} — дефект «благословлён» golden:write и не пойман`);
  else if (fails.length === 0) problems.push(`selftest exit ${st.status}, но ни одной строки FAIL — упал не ассертом: ${lastLine(st.stderr).slice(0, 200)}`);
  else if (named.length === 0) problems.push(`selftest упал (${fails.length} FAIL), но ни одна FAIL-строка не называет кейс ${sc.probeCase} (${sc.probeNames.join("/")}): ${fails.slice(0, 2).map((l) => l.slice(0, 120)).join(" | ")}`);

  return {
    name: `T.1 ${sc.name}`,
    problems,
    facts: `мутация: ${mutation}; после golden:write эталон ${sc.probeCase}: ${where}, exchange.pct ${fmt(b.exch)}, status ${b.status}; ` +
      `selftest: exit ${st.status}, FAIL-строк ${fails.length} (с «${sc.probeCase}» ${named.length})${fails.length ? ": " + fails.slice(0, 2).map((l) => l.slice(0, 160)).join(" | ") : ""}`,
  };
}

const ROLF = { probeCase: "rolf", probeNames: ["rolf", "RU000A10ASE2"] };
const SCENARIOS: Scenario[] = [
  { ...ROLF, name: "данные (биржа +3 п.п., own стоит)", ctlDisabled: false, mutate: (c) => [bumpExchangeYield(c, "rolf", 3)] },
  { ...ROLF, name: "код (yieldOf × 1,05, биржа стоит)", ctlDisabled: false, mutate: (c) => [mutateYieldOf(c, 1.05)] },
  {
    ...ROLF, name: "код без контроля (yieldOf × 1,05 + controlDiff → null: ни control_diff_pp, ни «контроль:»)", ctlDisabled: true,
    mutate: (c) => [mutateControlDiffNull(c), mutateYieldOf(c, 1.05)],
  },
];

/* ───── T.2: классы golden ───── */
interface Probe { name: string; dir: string; todayIso: string; r: BondReportT }
interface ClassResult { ok: boolean; near: boolean; facts: string }
interface ClassDef { key: string; title: string; fixtures: string[]; test: (p: Probe) => ClassResult }

/** |цена − цена колла| меньше этого — горизонты «колл» и «погашение» неразличимы, класс F не проверяется */
const PRICE_VS_CALL_MIN = 0.25;

function goldenProbes(): Probe[] {
  const meta = goldenCases();
  const out: Probe[] = [];
  for (const c of meta.cases) {
    const expFile = path.join(GOLDEN_DIR, "expected", c.name + ".json");
    if (!fs.existsSync(expFile)) continue;
    const e = JSON.parse(fs.readFileSync(expFile, "utf8")) as { kind: string; report?: BondReportT };
    if (e.kind !== "report" || !e.report) continue;
    out.push({ name: c.name, dir: path.join(GOLDEN_DIR, "snapshots", c.name), todayIso: c.todayIso ?? meta.todayIso, r: e.report });
  }
  return out;
}
async function fixtureProbe(name: string): Promise<Probe | null> {
  if (!hasFixture(name)) return null;
  const dir = path.join(FIXTURES_DIR, name);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as { todayIso: string };
  const res = await buildFixture(name);
  if (res.kind !== "report") return null;
  return { name, dir, todayIso: meta.todayIso, r: reportOf(res) };
}

const CLASSES: ClassDef[] = [
  {
    key: "A",
    title: "секьюритизация: купоны value=null ПОСЛЕ будущих частичных амортизаций (купон от остатка)",
    fixtures: ["sfo_ast0", "tb9a"],
    test: (p) => {
      const n3 = readDoc(p.dir, N3, "№3 bondization");
      const sec = rowsOf(readDoc(p.dir, N1, "№1"), "securities")[0] ?? {};
      const matIso = isoOrNull(sec.MATDATE) ?? dmyToIso(p.r.product.maturity_date);
      const amortFuture = rowsOf(n3, "amortizations")
        .filter((a) => String(a.data_source) === "amortization" && isoOrNull(a.amortdate) && String(a.amortdate) > p.todayIso && String(a.amortdate) !== matIso)
        .map((a) => String(a.amortdate));
      const nullFuture = rowsOf(n3, "coupons").filter((c) => String(c.coupondate) > p.todayIso && toNum(c.value) == null);
      const nullAfter = nullFuture.filter((c) => amortFuture.some((a) => a < String(c.coupondate))).length;
      const ok = nullAfter > 0 && p.r.product.amortization && p.r.status.kind === "ok";
      return {
        ok,
        near: p.r.product.amortization, // null-купоны без амортизации (put-reset, флоатер) — другой класс
        facts: `amortization=${p.r.product.amortization}, будущих частичных амортизаций ${amortFuture.length}, будущих купонов value=null ${nullFuture.length}, из них после амортизации ${nullAfter}, status ${p.r.status.kind}, own ${fmt(p.r.yield.own_control_pct)} vs биржа ${fmt(p.r.yield.exchange.pct)}`,
      };
    },
  },
  {
    key: "F",
    title: `колл-бумага: биржа считает к коллу (datetype OFFER), колл не «скорый» (days_to > callSoonDays=${CONFIG.flags.callSoonDays}, строго — ровно ${CONFIG.flags.callSoonDays} есть зона «<» vs «<=» из G.6), цена ≠ цене колла (|clean − колл| ≥ ${PRICE_VS_CALL_MIN} в любую сторону: премия ИЛИ дисконт — дефект горизонта двусторонний, F.2 min→call покрыт синтетикой wp-f)`,
    fixtures: ["call_telhol"],
    test: (p) => {
      const o = p.r.product.offer, ex = p.r.yield.exchange, clean = p.r.price.clean_pct;
      const gap = clean != null && o.price_pct != null ? Math.abs(clean - o.price_pct) : null;
      const notSoon = (o.days_to ?? -1) > CONFIG.flags.callSoonDays; // строго: ровно callSoonDays — неоднозначно (G.6)
      const ok = o.type === "call" && ex.datetype === "OFFER" && ex.pct != null && notSoon &&
        gap != null && gap >= PRICE_VS_CALL_MIN && p.r.status.kind === "ok";
      return {
        ok,
        near: o.type === "call",
        facts: `offer ${o.type}${o.date ? " " + o.date : ""}, days_to ${o.days_to ?? "null"} (${notSoon ? ">" : "≤"} порога ${CONFIG.flags.callSoonDays}), цена колла ${fmt(o.price_pct)}, clean ${fmt(clean, 3)} (|clean − колл| ${fmt(gap)}${gap != null && clean != null && o.price_pct != null ? (clean > o.price_pct ? ", премия" : clean < o.price_pct ? ", дисконт" : "") : ""}), exchange ${fmt(ex.pct)} datetype ${ex.datetype}, horizon ${p.r.yield.horizon}, status ${p.r.status.kind}`,
      };
    },
  },
  {
    key: "C",
    title: "биржевая доходность ровно 0 при опубликованной цене (первая непустая в цепочке ISS), status ok",
    fixtures: ["C_veb_zero0", "C_veb_prev0"],
    test: (p) => {
      const d1 = readDoc(p.dir, N1, "№1");
      const my = rowsOf(d1, "marketdata_yields")[0] ?? {}, md = rowsOf(d1, "marketdata")[0] ?? {}, sec = rowsOf(d1, "securities")[0] ?? {};
      const chain: [string, number | null, number | null][] = [
        ["EFFECTIVEYIELDWAPRICE", toNum(my.EFFECTIVEYIELDWAPRICE), toNum(my.WAPRICE)],
        ["YIELDATWAPRICE", toNum(md.YIELDATWAPRICE), toNum(md.WAPRICE)],
        ["YIELDATPREVWAPRICE", toNum(sec.YIELDATPREVWAPRICE), toNum(sec.PREVWAPRICE)],
      ];
      const first = chain.find(([, y]) => y != null) ?? null;
      const zero = first != null && first[1] === 0 && first[2] != null;
      const ok = zero && p.r.status.kind === "ok";
      return {
        ok,
        near: chain.some(([, y]) => y === 0),
        facts: `${chain.map(([n, y, pr]) => `${n}=${fmt(y, 4)}@${fmt(pr)}`).join(", ")}; первая непустая: ${first ? `${first[0]}=${fmt(first[1], 4)}` : "нет"}; status ${p.r.status.kind}, main_pct ${fmt(p.r.yield.main_pct)}`,
      };
    },
  },
  {
    key: "B",
    title: "пятничный снимок РОЛЬФ (RU000A10ASE2): todayIso — пятница, SETTLEDATE через выходные (≥ T+3)",
    fixtures: ["rolf_friday"],
    test: (p) => {
      const isRolf = p.r.security.secid === "RU000A10ASE2" || p.r.security.isin === "RU000A10ASE2";
      const sec = rowsOf(readDoc(p.dir, N1, "№1"), "securities")[0] ?? {};
      const settle = isoOrNull(sec.SETTLEDATE);
      const lag = settle ? daysBetween(p.todayIso, settle) : null;
      const d = dow(p.todayIso);
      const ok = isRolf && d === 5 && lag != null && lag >= 3 && p.r.status.kind === "ok";
      return {
        ok,
        near: isRolf,
        facts: `secid ${p.r.security.secid}, todayIso ${p.todayIso} (${DOW[d]}), SETTLEDATE ${settle ?? "null"} (T+${lag ?? "?"}), own ${fmt(p.r.yield.own_control_pct)} vs биржа ${fmt(p.r.yield.exchange.pct)} Δ ${fmt(p.r.yield.control_diff_pp)}, status ${p.r.status.kind}`,
      };
    },
  },
];

/* ───── T.5: мини-модель sh для npm-скриптов ─────
 * Исполняет scripts.check «на бумаге» при заданном множестве падающих раннеров и возвращает итоговый exit-код.
 * Каждый `npm run <script>` и `sh -c` — отдельный процесс (свои переменные, свой `exit`, свой `set -e`). */
type Runner = "engine" | "web";
const RUNNERS: Runner[] = ["engine", "web"];
const RU: Record<Runner, string> = { engine: "движка", web: "веба" };
type Scripts = Record<string, string>;

/** `npm run [флаги] audit` — ровно скрипт audit корня (не audit:engine / audit:web / audit-…); только для заметки о форме плана */
const RE_RUN_AUDIT = /npm run (?:-[a-z-]+\s+)*audit(?![:\w-])/;
const RE_ENGINE_LEAF = /audit:engine(?![\w-])|packages\/engine\/src\/audit\/harness/;
const RE_WEB_LEAF = /audit:web(?![\w-])|apps\/web\/audit\/harness/;
const WS_ENGINE = /^(?:@so\/engine|(?:\.\/)?packages\/engine\/?|engine)$/;
const WS_WEB = /^(?:@so\/web|(?:\.\/)?apps\/web\/?|web)$/;
const COMPOUND = new Set(["run-s", "run-p", "npm-run-all", "concurrently"]);
/** флаги concurrently / npm-run-all, у которых есть аргумент */
const COMPOUND_VALUE_FLAGS = new Set(["-n", "--names", "-c", "--prefix-colors", "-p", "--prefix", "-t", "--timestamp-format", "-m", "--max-processes", "--npm-path", "-l", "--prefix-length"]);

interface Ctx { scripts: Scripts; fail: Set<Runner>; ran: Set<Runner>; entered: Set<string>; unsupported: string[]; depth: number }
interface State { vars: Map<string, number>; last: number; errexit: boolean; exited: number | null; trace: string[] }
type Op = { op: "&&" | "||" | ";" };
type Item = string | Op;
const isOp = (x: Item): x is Op => typeof x !== "string";
const short = (s: string, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Разбивает текст скрипта на команды и операторы «;» «&&» «||» (кавычки и $((…)) не разбиваются); неразбираемое — в bad */
function tokenize(text: string): { items: Item[]; bad: string[] } {
  const items: Item[] = [];
  const bad: string[] = [];
  let cur = "", q: string | null = null, arith = 0;
  const flush = () => { if (cur.trim()) items.push(cur.trim()); cur = ""; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      cur += ch;
      if (ch === "\\" && q === '"') cur += text[++i] ?? "";
      else if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (text.startsWith("$((", i)) { arith++; cur += "$(("; i += 2; continue; }
    if (arith && text.startsWith("))", i)) { arith--; cur += "))"; i += 1; continue; }
    if (arith) { cur += ch; continue; }
    if (text.startsWith("&&", i)) { flush(); items.push({ op: "&&" }); i++; continue; }
    if (text.startsWith("||", i)) { flush(); items.push({ op: "||" }); i++; continue; }
    if (ch === ";" || ch === "\n") { flush(); items.push({ op: ";" }); continue; }
    if (ch === "|") bad.push("«|» (конвейер: без pipefail код левой команды теряется)");
    if (ch === "&") bad.push("«&» (фоновый запуск)");
    if (ch === "`") bad.push("«`…`» (подстановка команды)");
    if (text.startsWith("$(", i)) bad.push("«$(…)» (подстановка команды)");
    cur += ch;
  }
  if (q) bad.push("незакрытая кавычка");
  flush();
  return { items, bad };
}

/** Аргументы команды: по пробелам, кавычки снимаются */
function splitArgs(cmd: string): string[] {
  const out: string[] = [];
  let cur = "", q: string | null = null, has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ""; has = false; continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** $((…)): переменные (с $ и без), $?, операторы || && | & == != + − * ! и скобки; null — не разобрано */
function arith(expr: string, st: State): number | null {
  const src = expr
    .replace(/\$\?/g, String(st.last))
    .replace(/\$\{?([A-Za-z_]\w*)\}?/g, (_, n: string) => String(st.vars.get(n) ?? 0))
    .replace(/\b([A-Za-z_]\w*)\b/g, (_, n: string) => String(st.vars.get(n) ?? 0));
  const toks = src.match(/\d+|\|\||&&|==|!=|[-+*|&!()]/g) ?? [];
  if (toks.join("") !== src.replace(/\s+/g, "")) return null;
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const prim = (): number => {
    const t = next();
    if (t === "(") { const v = or(); if (next() !== ")") throw new Error("paren"); return v; }
    if (t === "!") return prim() ? 0 : 1;
    if (t === "-") return -prim();
    if (t == null || !/^\d+$/.test(t)) throw new Error("tok");
    return Number(t);
  };
  const mul = () => { let v = prim(); while (peek() === "*") { next(); v *= prim(); } return v; };
  const add = () => { let v = mul(); while (peek() === "+" || peek() === "-") { const o = next(); const r = mul(); v = o === "+" ? v + r : v - r; } return v; };
  const eq = () => { let v = add(); while (peek() === "==" || peek() === "!=") { const o = next(); const r = add(); v = o === "==" ? (v === r ? 1 : 0) : (v !== r ? 1 : 0); } return v; };
  const band = () => { let v = eq(); while (peek() === "&") { next(); v &= eq(); } return v; };
  const bor = () => { let v = band(); while (peek() === "|") { next(); v |= band(); } return v; };
  const and = () => { let v = bor(); while (peek() === "&&") { next(); const r = bor(); v = v && r ? 1 : 0; } return v; };
  const or = (): number => { let v = and(); while (peek() === "||") { next(); const r = and(); v = v || r ? 1 : 0; } return v; };
  try { const v = or(); return i === toks.length ? v : null; } catch { return null; }
}

/** Значение слова: число, $?, $X, ${X}, ${X:-d}, $((…)); undefined — пусто/не задано */
function value(tok: string | undefined, st: State, ctx: Ctx): number | undefined {
  if (tok == null) return undefined;
  const t = tok.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (t === "") return undefined;
  if (t === "$?") return st.last;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^\$\(\(([\s\S]*)\)\)$/))) {
    const v = arith(m[1], st);
    if (v == null) ctx.unsupported.push(`арифметика «${short(t)}»`);
    return v ?? undefined;
  }
  if ((m = t.match(/^\$\{([A-Za-z_]\w*)(?::?-(.*))?\}$/))) return st.vars.get(m[1]) ?? (m[2] != null ? value(m[2], st, ctx) : undefined);
  if ((m = t.match(/^\$([A-Za-z_]\w*)$/))) return st.vars.get(m[1]);
  if (/^-?\d+$/.test(t)) return Number(t);
  ctx.unsupported.push(`значение «${short(t)}»`);
  return undefined;
}

/** `[ a -eq b ]`, `[[ … ]]`, `test …`: числовые/строковые сравнения, -n/-z; 2 = ошибка синтаксиса (как в sh) */
function evalTest(args: string[], st: State, ctx: Ctx): number {
  const t = args.slice(1);
  if (t.length && (t[t.length - 1] === "]" || t[t.length - 1] === "]]")) t.pop();
  const num = (x: string) => value(x, st, ctx);
  if (t.length === 3) {
    const a = num(t[0]), b = num(t[2]);
    if (a == null || b == null) return 2;
    switch (t[1]) {
      case "-eq": case "=": case "==": return a === b ? 0 : 1;
      case "-ne": case "!=": return a !== b ? 0 : 1;
      case "-gt": return a > b ? 0 : 1;
      case "-ge": return a >= b ? 0 : 1;
      case "-lt": return a < b ? 0 : 1;
      case "-le": return a <= b ? 0 : 1;
    }
  }
  if (t.length === 2 && (t[0] === "-n" || t[0] === "-z")) {
    const set = num(t[1]) != null;
    return (t[0] === "-n" ? set : !set) ? 0 : 1;
  }
  ctx.unsupported.push(`условие «${short(args.join(" "))}»`);
  return 2;
}

function runner(r: Runner, st: State, ctx: Ctx): number {
  ctx.ran.add(r);
  const s = ctx.fail.has(r) ? 1 : 0;
  st.trace.push(`${r === "engine" ? "движок" : "веб"}→${s}`);
  return s;
}

function runScript(name: string, st: State, ctx: Ctx): number {
  if (ctx.depth >= 6) { ctx.unsupported.push(`вложенность npm run глубже 6 (${name})`); return 0; }
  ctx.depth++;
  ctx.entered.add(name);
  const r = runProcess(ctx.scripts[name] ?? "", ctx);
  ctx.depth--;
  st.trace.push(`${name}{${r.trace}}→${r.status}`);
  return r.status;
}

interface NpmRun { ws: string[]; all: boolean; name?: string }
function parseNpm(a: string[]): NpmRun | null {
  if (a[0] !== "npm") return null;
  const ws: string[] = [], pos: string[] = [];
  let all = false;
  for (let i = 1; i < a.length; i++) {
    const t = a[i];
    if (t === "--") break;
    let m: RegExpMatchArray | null;
    if (t === "-w" || t === "--workspace" || t === "--prefix" || t === "-C") { ws.push(a[++i] ?? ""); continue; }
    if ((m = t.match(/^(?:-w|--workspace|--prefix|-C)=(.+)$/))) { ws.push(m[1]); continue; }
    if (t === "-ws" || t === "--workspaces") { all = true; continue; }
    if (t.startsWith("-")) continue;
    pos.push(t);
  }
  const ri = pos.findIndex((p) => p === "run" || p === "run-script");
  if (ri < 0) return null;
  return { ws, all, name: pos[ri + 1] };
}

function runCmd(raw: string, st: State, ctx: Ctx): number {
  let c = raw.trim();
  let neg = false;
  if (/^!\s/.test(c)) { neg = true; c = c.replace(/^!\s+/, ""); }
  const s = runCmd0(c, st, ctx);
  return neg ? (s === 0 ? 1 : 0) : s;
}
function runCmd0(c: string, st: State, ctx: Ctx): number {
  const t = (s: string) => { st.trace.push(s); };
  const unknown = () => { t(`«${short(c)}»≈0`); return 0; };
  if (/^(?:\(|\{|if\s|for\s|while\s|until\s|case\s|cd\s|cd$|eval\s|exec\s|source\s|\.\s|pnpm\s|yarn\s)/.test(c)) {
    ctx.unsupported.push(`конструкция «${short(c)}»`);
    return 0;
  }
  let m: RegExpMatchArray | null;
  if ((m = c.match(/^(?:sh|bash|zsh|dash)\s+(?:-\w+\s+)*-c\s+(['"])([\s\S]*)\1\s*$/))) {
    const r = runProcess(m[2], ctx);
    t(`sh -c{${r.trace}}→${r.status}`);
    return r.status;
  }
  if ((m = c.match(/^(?:export\s+)?([A-Za-z_]\w*)=([\s\S]*)$/))) {
    const rest = m[2];
    const pm = rest.match(/^(\S*)\s+(\S[\s\S]*)$/);
    if (pm && !rest.startsWith("$((")) return runCmd0(pm[2], st, ctx); // префикс окружения `K=V cmd`
    const v = value(rest, st, ctx);
    if (v == null) st.vars.delete(m[1]); else st.vars.set(m[1], v);
    t(`${m[1]}=${short(rest, 24)}(${v ?? "∅"})`);
    return 0;
  }
  if ((m = c.match(/^exit(?:\s+([\s\S]+))?$/))) {
    const v = m[1] != null ? value(m[1], st, ctx) : undefined;
    const code = v ?? st.last;
    st.exited = code;
    t(`exit${m[1] ? " " + short(m[1], 24) : ""}→${code}`);
    return code;
  }
  const a = splitArgs(c);
  if (!a.length) return 0;
  if (a[0] === "true" || a[0] === ":") return 0;
  if (a[0] === "false") return 1;
  if (a[0] === "[" || a[0] === "[[" || a[0] === "test") { const s = evalTest(a, st, ctx); t(`${short(c, 40)}→${s}`); return s; }
  if (a[0] === "set") {
    const f = a.slice(1).join(" ");
    if (/(?:^|\s)-\w*e|-o\s+errexit/.test(f)) st.errexit = true;
    if (/(?:^|\s)\+\w*e|\+o\s+errexit/.test(f)) st.errexit = false;
    t(`set ${f}`);
    return 0;
  }
  if (a[0] === "echo" || a[0] === "printf") return 0;
  if (a[0] === "npm") {
    const np = parseNpm(a);
    if (!np) return unknown();
    if (np.name === "audit" && (np.all || np.ws.length)) {
      const rs = np.all
        ? RUNNERS
        : np.ws.map((w): Runner | null => (WS_ENGINE.test(w) ? "engine" : WS_WEB.test(w) ? "web" : null)).filter((x): x is Runner => x != null);
      if (!rs.length) return unknown();
      let s = 0;
      for (const r of rs) s = Math.max(s, runner(r, st, ctx));
      return s;
    }
    if (np.ws.length || np.all) return unknown();
    if (np.name && ctx.scripts[np.name] != null) return runScript(np.name, st, ctx);
    if (np.name && RE_ENGINE_LEAF.test(np.name)) return runner("engine", st, ctx);
    if (np.name && RE_WEB_LEAF.test(np.name)) return runner("web", st, ctx);
    return unknown();
  }
  if (COMPOUND.has(a[0])) {
    const args = a.slice(1);
    if (args.some((x) => /^(?:--success|--race|--kill-others|-k|--kill-others-on-fail)(?:=|$)/.test(x))) {
      ctx.unsupported.push(`${a[0]} с флагом успеха/гонки («${short(c)}»)`);
      return 0;
    }
    const targets: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (COMPOUND_VALUE_FLAGS.has(args[i])) { i++; continue; }
      if (args[i].startsWith("-")) continue;
      targets.push(args[i].replace(/^npm:/, ""));
    }
    let s = 0;
    const sub: string[] = [];
    for (const tg of targets) {
      if (/\s/.test(tg)) { const r = runProcess(tg, ctx); sub.push(`«${short(tg, 40)}»{${r.trace}}→${r.status}`); s = Math.max(s, r.status); continue; }
      const names = tg.endsWith("*") ? Object.keys(ctx.scripts).filter((k) => k.startsWith(tg.slice(0, -1))) : [tg];
      for (const n of names) {
        if (ctx.scripts[n] != null) { const sst: State = { ...st, trace: [] }; s = Math.max(s, runScript(n, sst, ctx)); sub.push(...sst.trace); }
        else sub.push(`${n}≈0`);
      }
    }
    t(`${a[0]}[${sub.join(" , ")}]→${s ? 1 : 0}`);
    return s ? 1 : 0;
  }
  if (RE_ENGINE_LEAF.test(c)) return runner("engine", st, ctx);
  if (RE_WEB_LEAF.test(c)) return runner("web", st, ctx);
  return unknown();
}

/** Один процесс sh: AND-OR-списки через «;», `set -e` для последней команды списка, `exit` завершает процесс */
function runProcess(text: string, ctx: Ctx): { status: number; trace: string } {
  const st: State = { vars: new Map(), last: 0, errexit: false, exited: null, trace: [] };
  const { items, bad } = tokenize(text);
  ctx.unsupported.push(...bad);
  let op: Op["op"] | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (isOp(it)) { op = it.op; continue; }
    const nxt = items[i + 1];
    const nextOp = nxt != null && isOp(nxt) ? nxt.op : null;
    if ((op === "&&" && st.last !== 0) || (op === "||" && st.last === 0)) { st.trace.push(`(пропуск: ${short(it, 30)})`); continue; }
    const s = runCmd(it, st, ctx);
    if (st.exited != null) break;
    st.last = s;
    if (st.errexit && s !== 0 && nextOp !== "&&" && nextOp !== "||") { st.exited = s; st.trace.push(`set -e → exit ${s}`); break; }
  }
  return { status: st.exited ?? st.last, trace: st.trace.join(" ; ") };
}

interface SimResult { exit: number; trace: string; ran: Set<Runner>; entered: Set<string>; unsupported: string[] }
function simulate(S: Scripts, entry: string, fail: Runner[]): SimResult {
  const ctx: Ctx = { scripts: S, fail: new Set(fail), ran: new Set(), entered: new Set(), unsupported: [], depth: 0 };
  const r = S[entry] != null ? runProcess(S[entry], ctx) : { status: 0, trace: "(скрипта нет)" };
  return { exit: r.status, trace: r.trace, ran: ctx.ran, entered: ctx.entered, unsupported: [...new Set(ctx.unsupported)] };
}

interface Issue { code: string; text: string }
interface Assessment { issues: Issue[]; notes: string[]; facts: string[] }
const SUPPORTED_HINT = "упростите скрипт до «;», «&&», «||», X=$?, exit $X / $((A|B)), [ … ], set -e, sh -c '…', run-s";

/** Решающая функция T.5 — одна и та же для реального package.json и для самопроверки модели */
function assess(S: Scripts): Assessment {
  const issues: Issue[] = [], notes: string[] = [], facts: string[] = [];
  if (S.check == null) { issues.push({ code: "no-check", text: "scripts.check отсутствует" }); return { issues, notes, facts }; }
  const base = simulate(S, "check", []);
  facts.push(`раннеры зелёные: check → exit ${base.exit} [${base.trace}]`);
  if (base.unsupported.length) {
    issues.push({ code: "unsupported", text: `модель sh не распознаёт: ${base.unsupported.join(", ")} — проброс exit-кода НЕ подтверждён (${SUPPORTED_HINT})` });
    return { issues, notes, facts };
  }
  for (const r of RUNNERS)
    if (!base.ran.has(r)) issues.push({ code: `unreached:${r}`, text: `check не доходит до раннера ${RU[r]} (ни npm run audit → scripts.audit, ни audit:${r}, ни -w @so/${r} audit)` });
  if (base.exit !== 0) issues.push({ code: "always-fail", text: `check с зелёными раннерами завершается exit ${base.exit} — отказ раннера неотличим от штатного прохода` });
  for (const r of RUNNERS) {
    if (!base.ran.has(r)) continue;
    const f = simulate(S, "check", [r]);
    facts.push(`отказ ${RU[r]} (exit 1): check → exit ${f.exit} [${f.trace}]`);
    if (f.exit === 0) issues.push({ code: `swallow:${r}`, text: `отказ ${RU[r]} не доходит до exit-кода check (итог 0): ${f.trace}` });
  }
  if (base.ran.size === RUNNERS.length) {
    const both = simulate(S, "check", RUNNERS);
    facts.push(`отказ обоих: check → exit ${both.exit}`);
    if (both.exit === 0 && !issues.some((i) => i.code.startsWith("swallow:"))) issues.push({ code: "swallow:both", text: `одновременный отказ обоих раннеров даёт exit 0: ${both.trace}` });
  }
  // scripts.audit отдельно — соглашение харнеса «npm run audit → exit 1 при любом RED/ERROR»
  if (S.audit == null) notes.push("scripts.audit отсутствует — соглашение «npm run audit → exit 1» неприменимо");
  else if (base.entered.has("audit")) notes.push("check идёт через `npm run audit` — проброс scripts.audit учтён в трассах check");
  else {
    const ab = simulate(S, "audit", []);
    if (ab.unsupported.length) issues.push({ code: "unsupported", text: `scripts.audit: модель sh не распознаёт ${ab.unsupported.join(", ")} (${SUPPORTED_HINT})` });
    else
      for (const r of RUNNERS) {
        if (!ab.ran.has(r)) { notes.push(`scripts.audit не вызывает раннер ${RU[r]}`); continue; }
        const f = simulate(S, "audit", [r]);
        if (f.exit === 0) issues.push({ code: `audit-swallow:${r}`, text: `scripts.audit сам по себе глотает отказ ${RU[r]} (exit 0: ${f.trace}) — нарушено соглашение харнеса «npm run audit → exit 1 при любом RED/ERROR»` });
        else notes.push(`scripts.audit: отказ ${RU[r]} → exit ${f.exit}`);
      }
  }
  if (RE_RUN_AUDIT.test(S.check)) notes.push("форма плана: check вызывает `npm run audit`");
  else if (base.ran.size) notes.push(`check вызывает раннеры не через \`npm run audit\` (${[...base.entered].filter((n) => n !== "check").join(", ") || "напрямую -w"}) — принято как эквивалентная форма`);
  return { issues, notes, facts };
}

/** Самопроверка модели: ожидаемые коды проблем на синтетических package.json; расхождение — ERROR харнеса */
const E = "npm run -w @so/engine audit -- $npm_config_audit_args";
const W = "npm run -w @so/web audit -- $npm_config_audit_args";
const SPLIT = { "audit:engine": "npm run -w @so/engine audit --", "audit:web": "npm run -w @so/web audit --" };
const BASE = { selftest: "npm run -w @so/engine selftest", pages: "npm run -w @so/static build", validate: "npm run -w @so/validate validate" };
const SELF: { name: string; scripts: Scripts; expect: string[] }[] = [
  { name: "текущий package.json (аудита в check нет, audit через «;»)", scripts: { ...BASE, check: "npm run selftest && npm run pages && npm run validate", audit: `${E}; ${W}` }, expect: ["unreached:engine", "unreached:web", "audit-swallow:engine"] },
  { name: "план: npm run audit в check, audit = E && W", scripts: { ...BASE, check: "npm run selftest && npm run pages && npm run validate && npm run audit", audit: `${E} && ${W}` }, expect: [] },
  { name: "audit:engine && audit:web в check, audit удалён", scripts: { ...BASE, ...SPLIT, check: "npm run selftest && npm run audit:engine && npm run audit:web" }, expect: [] },
  { name: "audit:engine && audit:web в check, audit остался через «;»", scripts: { ...BASE, ...SPLIT, check: "npm run selftest && npm run audit:engine && npm run audit:web", audit: `${E}; ${W}` }, expect: ["audit-swallow:engine"] },
  { name: "audit = E; W (движок глотается)", scripts: { ...BASE, check: "npm run selftest && npm run audit", audit: `${E}; ${W}` }, expect: ["swallow:engine"] },
  { name: "audit = E; X=$?; W; exit $X (веб глотается)", scripts: { ...BASE, check: "npm run audit", audit: `${E}; X=$?; ${W}; exit $X` }, expect: ["swallow:web"] },
  { name: "audit = E; W; true; X=$?; exit $X (оба глотаются)", scripts: { ...BASE, check: "npm run audit", audit: `${E}; ${W}; true; X=$?; exit $X` }, expect: ["swallow:engine", "swallow:web"] },
  { name: "audit = E; X=$?; W || X=1; exit $X", scripts: { ...BASE, check: "npm run audit", audit: `${E}; X=$?; ${W} || X=1; exit $X` }, expect: [] },
  { name: "audit = E; X=$?; W; exit $((X|$?))", scripts: { ...BASE, check: "npm run audit", audit: `${E}; X=$?; ${W}; exit $((X|$?))` }, expect: [] },
  { name: "audit = E; X=$?; W; Y=$?; exit $(( X || Y ))", scripts: { ...BASE, check: "npm run audit", audit: `${E}; X=$?; ${W}; Y=$?; exit $(( X || Y ))` }, expect: [] },
  { name: "audit = …; [ $X -eq 0 ] && exit $Y || exit $X", scripts: { ...BASE, check: "npm run audit", audit: `${E}; X=$?; ${W}; Y=$?; [ "$X" -eq 0 ] && exit $Y || exit $X` }, expect: [] },
  { name: "audit = E; X=$?; W; Y=$?; exit $((X+Y)) — сумма тоже ненулевая", scripts: { ...BASE, check: "npm run audit", audit: `${E}; X=$?; ${W}; Y=$?; exit $((X+Y))` }, expect: [] },
  { name: "audit = set -e; E; W", scripts: { ...BASE, check: "npm run audit", audit: `set -e; ${E}; ${W}` }, expect: [] },
  { name: "audit = sh -c 'E; e=$?; W; exit $((e|$?))'", scripts: { ...BASE, check: "npm run audit", audit: `sh -c '${E}; e=$?; ${W}; exit $((e|$?))'` }, expect: [] },
  { name: "audit = run-s audit:engine audit:web", scripts: { ...BASE, ...SPLIT, check: "npm run audit", audit: "run-s audit:engine audit:web" }, expect: [] },
  { name: "audit = npm-run-all audit:*", scripts: { ...BASE, ...SPLIT, check: "npm run audit", audit: "npm-run-all audit:*" }, expect: [] },
  { name: "audit = concurrently \"npm run audit:engine\" \"npm run audit:web\"", scripts: { ...BASE, ...SPLIT, check: "npm run audit", audit: 'concurrently "npm run audit:engine" "npm run audit:web"' }, expect: [] },
  { name: "audit = E | tee log; W (конвейер — не распознаётся)", scripts: { ...BASE, check: "npm run audit", audit: `${E} | tee audit.log; ${W}` }, expect: ["unsupported"] },
  { name: "audit = cd packages/engine && … (не распознаётся)", scripts: { ...BASE, check: "npm run audit", audit: "cd packages/engine && tsx src/audit/harness.ts" }, expect: ["unsupported"] },
  { name: "check = npm run audit; false (падает всегда)", scripts: { ...BASE, check: "npm run audit; false", audit: `${E} && ${W}` }, expect: ["always-fail"] },
  { name: "check вызывает только audit:engine", scripts: { ...BASE, ...SPLIT, check: "npm run selftest && npm run audit:engine" }, expect: ["unreached:web"] },
  { name: "check = npm run audit || true", scripts: { ...BASE, check: "npm run audit || true", audit: `${E} && ${W}` }, expect: ["swallow:engine", "swallow:web"] },
  { name: "check = npm run audit; npm run validate (аудит перед «;»)", scripts: { ...BASE, check: "npm run audit; npm run validate", audit: `${E} && ${W}` }, expect: ["swallow:engine", "swallow:web"] },
  { name: "check = npm run audit -- --baseline && npm run validate", scripts: { ...BASE, check: "npm run audit -- --baseline && npm run validate", audit: `${E} && ${W}` }, expect: [] },
  { name: "флаги npm в другом порядке / через =", scripts: { ...BASE, check: "npm run audit", audit: "npm run audit -w @so/engine -- --json && npm --workspace=@so/web run audit && npm run -s --workspace @so/engine audit" }, expect: [] },
  { name: "раннеры по пути harness.ts", scripts: { ...BASE, check: "npm run audit", audit: "tsx packages/engine/src/audit/harness.ts && tsx apps/web/audit/harness.ts" }, expect: [] },
  { name: "audit = E; X=$?; W; exit (без аргумента → код веба)", scripts: { ...BASE, check: "npm run audit", audit: `${E}; X=$?; ${W}; exit` }, expect: ["swallow:engine"] },
  { name: "audit = E && W || exit 0 (отказ замаскирован)", scripts: { ...BASE, check: "npm run audit", audit: `${E} && ${W} || exit 0` }, expect: ["swallow:engine", "swallow:web"] },
  { name: "audit = ! E && W (отрицание: зелёный движок валит скрипт и не пускает веб, упавший — проходит)", scripts: { ...BASE, check: "npm run audit", audit: `! ${E} && ${W}` }, expect: ["always-fail", "swallow:engine", "unreached:web"] },
  { name: "audit = AUDIT_LIVE=0 E && W (префикс окружения)", scripts: { ...BASE, check: "npm run audit", audit: `AUDIT_LIVE=0 ${E} && ${W}` }, expect: [] },
  { name: "audit = E; W; exit $? (код веба затирает движок)", scripts: { ...BASE, check: "npm run audit", audit: `${E}; ${W}; exit $?` }, expect: ["swallow:engine"] },
  { name: "audit = E || X=1; W || X=1; exit ${X:-0}", scripts: { ...BASE, check: "npm run audit", audit: `${E} || X=1; ${W} || X=1; exit \${X:-0}` }, expect: [] },
  { name: "audit = npm run -ws --if-present audit (все workspaces)", scripts: { ...BASE, check: "npm run audit", audit: "npm run -ws --if-present audit" }, expect: [] },
  { name: "audit = …; exit $((X>Y?X:Y)) (тернарник в арифметике — не распознаётся)", scripts: { ...BASE, check: "npm run audit", audit: `${E}; X=$?; ${W}; Y=$?; exit $((X>Y?X:Y))` }, expect: ["unsupported"] },
  { name: "audit = (E && W) (подоболочка — не распознаётся)", scripts: { ...BASE, check: "npm run audit", audit: `(${E} && ${W})` }, expect: ["unsupported"] },
  { name: "audit = E & W; wait (фоновый запуск — не распознаётся)", scripts: { ...BASE, check: "npm run audit", audit: `${E} & ${W}; wait` }, expect: ["unsupported"] },
];
function selfCheck(): string {
  const bad: string[] = [];
  for (const c of SELF) {
    const got = assess(c.scripts).issues.map((i) => i.code).sort();
    const exp = [...c.expect].sort();
    if (got.join("|") !== exp.join("|")) bad.push(`«${c.name}»: ожидалось [${exp.join(", ")}], получено [${got.join(", ")}]`);
  }
  if (bad.length) throw new Error(`T.5: модель sh не проходит самопроверку (${bad.length} из ${SELF.length}): ${bad.join(" || ")}`);
  return `самопроверка модели: ${SELF.length} синтетических package.json распознаны верно`;
}

/* ───── проверки ───── */
export const checks: Check[] = [
  {
    id: "T.1",
    wp: "T",
    kind: "unit",
    title: "selftest падает на синтетическом расхождении own/биржа > 0,5 п.п. даже после golden:write — в т.ч. когда отчёт не считает control_diff и не пишет «контроль:» (own против EFFECTIVEYIELDWAPRICE снимка)",
    run: async () => {
      const blocks: Block[] = [];

      // статика по selftest.ts — только информационно (комментарий со словами инвариант не создаёт; решают сценарии ниже)
      const src = readSrc("packages/engine/src/selftest.ts");
      const cnt = (re: RegExp) => (src.match(re) ?? []).length;
      blocks.push({
        name: "selftest.ts: статика (информационно)",
        problems: [],
        facts: `упоминаний: control_diff_pp/controlWarnPp ${cnt(/control_diff_pp|controlWarnPp/g)}, «контроль» ${cnt(/контроль/g)}, EFFECTIVEYIELDWAPRICE ${cnt(/EFFECTIVEYIELDWAPRICE/g)}; golden-секция сравнивает JSON.stringify(strip(...)) (${cnt(/strip\(/g)} вызовов strip)`,
      });

      // поведение: копия движка → мутация → благословление → selftest (каждый сценарий в своей копии)
      for (const [i, sc] of SCENARIOS.entries()) {
        const copy = engineCopy(`s${i + 1}`);
        try {
          if (i === 0) {
            const pristine = tsx(copy, "src/selftest.ts");
            if (pristine.status !== 0)
              throw new Error(`selftest в чистой копии движка не зелёный (exit ${pristine.status}: «${lastLine(pristine.stdout)}») — T.1 неприменим, см. T.3`);
          }
          blocks.push(runScenario(copy, sc));
        } finally { dropCopy(copy); }
      }

      return verdict(blocks);
    },
  },
  {
    id: "T.2",
    wp: "T",
    kind: "static",
    title: "golden покрывает 4 класса: null-купоны после амортизации (A), колл к коллу с ценой ≠ колла — премия или дисконт, days_to строго > callSoonDays (F), биржевой 0 (C), пятничный РОЛЬФ (B); предикаты верифицируются на audit-fixtures (нет образца / не узнан → ERROR)",
    run: async () => {
      const probes = goldenProbes();
      const blocks: Block[] = [];
      for (const cls of CLASSES) {
        // предикат обязан узнавать хотя бы один свой образец в audit-fixtures — иначе он не верифицирован (ERROR харнеса, не RED)
        const demo: string[] = [];
        const misses: string[] = [];
        for (const fx of cls.fixtures) {
          if (!hasFixture(fx)) { misses.push(`${fx}: снимка нет в audit-fixtures`); continue; }
          const p = await fixtureProbe(fx);
          if (!p) { misses.push(`${fx}: сборка из снимка не даёт отчёта`); continue; }
          const r = cls.test(p);
          (r.ok ? demo : misses).push(`${fx}: ${r.facts}`);
        }
        if (!demo.length)
          throw new Error(`T.2: предикат класса ${cls.key} не верифицирован — ни один образец audit-fixtures (${cls.fixtures.join(", ")}) не найден или не узнан: ${misses.join(" | ")}`);

        const results = probes.map((p) => ({ p, r: cls.test(p) }));
        const hits = results.filter((x) => x.r.ok);
        const near = results.filter((x) => !x.r.ok && x.r.near);
        const problems = hits.length ? [] : [`в golden/cases.json нет кейса класса «${cls.title}»`];
        const facts = hits.length
          ? `покрыт: ${hits.map((h) => `${h.p.name} (${h.r.facts})`).join("; ")}`
          : `ближайшие golden: ${near.length ? near.map((n) => `${n.p.name} — ${n.r.facts}`).join("; ") : "нет"}` +
            `; образец класса в audit-fixtures (в golden не входит): ${demo.join("; ")}` +
            (misses.length ? `; образцы audit-fixtures вне класса: ${misses.join("; ")}` : "");
        blocks.push({ name: `класс ${cls.key}`, problems, facts });
      }
      return verdict(blocks);
    },
  },
  {
    id: "T.3",
    wp: "T",
    kind: "unit",
    guard: true,
    title: "npm run selftest зелёный (golden + паритет страница ≡ движок)",
    run: () => {
      const r = spawnSync("npm", ["run", "-s", "-w", "@so/engine", "selftest"], {
        cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000, env: { ...process.env },
      });
      if (r.error) throw r.error;
      const out = r.stdout ?? "", err = r.stderr ?? "";
      const fails = failLines(out);
      const oks = err.split("\n").filter((l) => /^ok\s/.test(l)).length;
      return expect(
        r.status === 0 && fails.length === 0,
        `exit ${r.status}; «${lastLine(out)}»; ok-строк ${oks}, FAIL-строк ${fails.length}${fails.length ? ": " + fails.slice(0, 3).map((l) => l.slice(0, 160)).join(" | ") : ""}`,
      );
    },
  },
  {
    id: "T.4",
    wp: "T",
    kind: "static",
    guard: true,
    title: "Эталоны golden: каждый кейс имеет снимок и expected, expected проходит BuildResult/BondReport.parse, snapshot_dir относительный, сирот нет",
    run: () => {
      const meta = goldenCases();
      const problems: string[] = [];
      const kinds: Record<string, number> = {};
      for (const c of meta.cases) {
        const expFile = path.join(GOLDEN_DIR, "expected", c.name + ".json");
        const snapDir = path.join(GOLDEN_DIR, "snapshots", c.name);
        if (!fs.existsSync(snapDir) || !fs.readdirSync(snapDir).some((f) => f.endsWith(".json"))) problems.push(`${c.name}: нет снимка golden/snapshots/${c.name}`);
        if (!fs.existsSync(expFile)) { problems.push(`${c.name}: нет эталона expected/${c.name}.json`); continue; }
        let e: unknown;
        try { e = JSON.parse(fs.readFileSync(expFile, "utf8")); } catch (err) { problems.push(`${c.name}: expected не JSON (${String(err).slice(0, 80)})`); continue; }
        const pr = BuildResult.safeParse(e);
        if (!pr.success) {
          problems.push(`${c.name}: BuildResult.parse — ${pr.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
          continue;
        }
        kinds[pr.data.kind] = (kinds[pr.data.kind] ?? 0) + 1;
        if (pr.data.kind === "report") {
          const br = BondReport.safeParse(pr.data.report);
          if (!br.success) problems.push(`${c.name}: BondReport.parse — ${br.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
          const sd = pr.data.report.diagnostics.snapshot_dir;
          if (sd !== `golden/snapshots/${c.name}`) problems.push(`${c.name}: diagnostics.snapshot_dir «${sd}» ≠ golden/snapshots/${c.name} (эталон зависит от машины)`);
        }
      }
      const orphans = fs.readdirSync(path.join(GOLDEN_DIR, "expected")).filter((f) => f.endsWith(".json") && !meta.cases.some((c) => c.name + ".json" === f));
      if (orphans.length) problems.push(`эталоны без кейса в cases.json: ${orphans.join(", ")}`);
      return verdict([{
        name: "golden",
        problems,
        facts: `${meta.cases.length} кейсов (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ")}), todayIso по умолчанию ${meta.todayIso}`,
      }]);
    },
  },
  {
    id: "T.5",
    wp: "T",
    kind: "static",
    title: "npm run check включает аудит-харнес, и отказ ЛЮБОГО раннера (движок/веб, exit 1) доходит до exit-кода check — мини-модель sh исполняет scripts.check при падении каждого раннера (понимает «;» «&&» «||», X=$?, exit $X/$((…)), [ … ], set -e, sh -c, run-s/concurrently, npm run по scripts/-w; конвейеры, подоболочки, if/for, cd, pnpm/yarn — RED «не подтверждено»); scripts.audit вне check тоже обязан пробрасывать отказ",
    run: () => {
      const self = selfCheck(); // сломанная модель → ERROR, не «честный» RED/GREEN
      const pkg = JSON.parse(readSrc("package.json")) as { scripts?: Record<string, string> };
      const S: Scripts = pkg.scripts ?? {};
      const a = assess(S);
      return verdict([{
        name: "package.json",
        problems: a.issues.map((i) => i.text),
        facts: `scripts.check = «${S.check ?? ""}»; scripts.audit = «${S.audit ?? ""}»; ${a.facts.join("; ")}${a.notes.length ? "; " + a.notes.join("; ") : ""}; ${self}; ` +
          "границы модели: любая нераспознанная команда считается успешной (exit 0), операторы внутри кавычек не разбираются (кроме sh -c), сравнения в [ … ] только числовые/-n/-z, run-s/concurrently — «любой отказ → ненулевой» без флагов успеха, флаги раннера (--baseline/--only/--json) не интерпретируются — моделируется только проброс его кода возврата",
      }]);
    },
  },
];
