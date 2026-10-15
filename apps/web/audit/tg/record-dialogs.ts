/**
 * WP-TG, эталон паритета (docs/PLAN_telegram_bot_2026-10-14.md §4.5, §6): запись настоящих тел POST /api/chat браузера.
 * Диалоги проигрываются в Chromium через реальный UI assistant-ui (ввод в .so-composer__input + Enter, кнопка «Проверить»
 * в блоке выбора выпуска, переход по ссылке /chat?…), каждое тело перехватывается page.on("request").
 * Результат — apps/web/audit/fixtures/dialogs/dN.json; фикстуры меняет только оркестратор после разбора диффа.
 *
 * Сервер — только MOCK, как в харнесе (§6 «Как устроен»): сборка и запуск из apps/web
 *   npx next build
 *   env -u OPENROUTER_API_KEY -u ANTHROPIC_API_KEY -u TYPESAFE_API_KEY -u LLM_PROVIDER -u SO_MESSAGE_LIMIT \
 *     SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0 SO_DAILY_BUDGET_USD=2 SO_USAGE_LOG=1 SO_USAGE_DIR=$(mktemp -d) \
 *     npx next start -H 127.0.0.1 -p <порт>
 * Запись (из корня репо; Chromium Playwright — из PLAYWRIGHT_BROWSERS_PATH, `playwright install` не нужен):
 *   node --import tsx apps/web/audit/tg/record-dialogs.ts --base http://127.0.0.1:<порт> --out apps/web/audit/fixtures/dialogs
 *     [--only d1,d5] [--commit <hash>] [--date YYYY-MM-DD]
 * Защита: /api/health не отвечает mode=mock (или Jev включён) → exit 2, ничего не пишется. Любое действие, давшее не ровно
 * один POST /api/chat (или ответ не 200), → exit 1, файл диалога не пишется.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Request as PwRequest } from "playwright";

/* ───── диалоги эталона ───── */
export type DialogAction = { kind: "type"; text: string } | { kind: "open"; url: string } | { kind: "pick"; index: number };
export interface DialogSpec { id: string; title: string; actions: DialogAction[] }

export const DIALOGS: DialogSpec[] = [
  {
    id: "d1", title: "ОФЗ 26238: отчёт, затем сумма и голое число «0,3»",
    actions: [{ kind: "type", text: "ОФЗ 26238" }, { kind: "type", text: "вложу 1 млн" }, { kind: "type", text: "0,3" }],
  },
  {
    id: "d2", title: "Черкизово: выбор выпуска, кнопка «Проверить» у кандидата 0",
    actions: [{ kind: "type", text: "Черкизово" }, { kind: "pick", index: 0 }],
  },
  {
    id: "d3", title: "Вход с главной (/chat?m=…): термин «дюрация», затем «а купон?»",
    actions: [{ kind: "open", url: "/chat?m=Что такое дюрация?" }, { kind: "type", text: "а купон?" }],
  },
  {
    id: "d4", title: "ISIN не найден на Мосбирже, затем просьба о совете",
    actions: [{ kind: "type", text: "RU000A10E2A5" }, { kind: "type", text: "предложи ты бумагу" }],
  },
  {
    id: "d5", title: "ЧеркизБ1P6 без биржевой цены: бот просит цену предложения, ответ «98,5%»",
    actions: [{ kind: "type", text: "RU000A105M67" }, { kind: "type", text: "98,5%" }],
  },
  {
    id: "d6", title: "Переход «отчёт → ассистент» (/chat?q=…): вводы полем inputs, затем вопрос «почему так мало?»",
    actions: [{ kind: "open", url: "/chat?q=RU000A1038V6&promised=15&pos=1000000&k=0.3" }, { kind: "type", text: "почему так мало?" }],
  },
  {
    id: "d7", title: "ВЭБ.РФ 21 по названию, затем «ты уверен?»",
    actions: [{ kind: "type", text: "ВЭБ.РФ 21" }, { kind: "type", text: "ты уверен?" }],
  },
];

/* ───── формат фикстуры ───── */
export interface RecordedRequest { action: number; headers: Record<string, string>; headerNames: string[]; body: unknown }
export interface DialogFixture {
  id: string; title: string;
  recorded: { commit: string; date: string; mode: string; browser: string; via: string };
  actions: DialogAction[];
  requests: RecordedRequest[];
}

const MODE = "SO_OFFLINE=1 MOCK_LLM=1 JEV_ENABLED=0";
const STEP_TIMEOUT_MS = 30_000;
/** После ответа ждём ещё столько, чтобы убедиться, что действие не породило второй POST */
const QUIET_MS = 1_000;

/* ───── аргументы ───── */
const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

function die(code: number, msg: string): never {
  console.error(`record-dialogs: ${msg}`);
  process.exit(code);
}

function gitShortHead(): string {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; }
}

/* ───── ожидания UI ───── */
const COMPOSER = ".so-composer__input";
/** Ход окончен: в ленте нет заглушек инструментов и снова видна кнопка «Отправить» (ThreadPrimitive.If running={false}) */
async function waitIdle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const send = document.querySelector('.so-composer__send[aria-label="Отправить"]');
    return !!send && !document.querySelector(".so-tool--pending");
  }, undefined, { timeout: STEP_TIMEOUT_MS });
}

interface Captured { action: number; req: PwRequest }

async function recordDialog(browser: Browser, base: string, d: DialogSpec, meta: DialogFixture["recorded"]): Promise<DialogFixture> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ru-RU" });
  const origin = new URL(base).origin;
  // Наружу браузер не ходит (шрифты Google и всё прочее): только сервер записи
  await ctx.route("**/*", (r) => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_FAILED|fonts/.test(m.text())) errors.push(m.text()); });

  const posts: Captured[] = [];
  let current = -1;
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/chat") posts.push({ action: current, req });
  });

  for (let i = 0; i < d.actions.length; i++) {
    const a = d.actions[i];
    const before = posts.length;
    current = i;
    if (a.kind === "open") {
      await page.goto(new URL(a.url, base).href);
      await page.waitForSelector(COMPOSER);
    } else {
      if (page.url() === "about:blank") {
        await page.goto(new URL("/chat", base).href);
        await page.waitForSelector(COMPOSER);
      }
      await waitIdle(page);
      if (a.kind === "type") {
        await page.fill(COMPOSER, a.text);
        await page.keyboard.press("Enter");
      } else {
        const block = page.locator('[data-role="assistant"] [data-block="pick"]').last();
        const btn = block.getByRole("button", { name: "Проверить", exact: true }).nth(a.index);
        await btn.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
        await btn.click();
      }
    }
    // ровно один POST на действие: дождаться его, полного ответа и простоя ленты, затем тишины
    const t0 = Date.now();
    while (posts.length === before) {
      if (Date.now() - t0 > STEP_TIMEOUT_MS) throw new Error(`${d.id}, действие ${i} (${JSON.stringify(a)}): POST /api/chat не ушёл за ${STEP_TIMEOUT_MS} мс`);
      await page.waitForTimeout(50);
    }
    const res = await posts[before].req.response();
    if (!res) throw new Error(`${d.id}, действие ${i}: нет ответа на POST /api/chat`);
    if (res.status() !== 200) throw new Error(`${d.id}, действие ${i}: POST /api/chat → ${res.status()}`);
    await res.finished();
    await waitIdle(page);
    await page.waitForTimeout(QUIET_MS);
    if (posts.length !== before + 1)
      throw new Error(`${d.id}, действие ${i} (${JSON.stringify(a)}): ушло ${posts.length - before} POST /api/chat вместо одного`);
  }

  const requests: RecordedRequest[] = [];
  for (const p of posts) {
    const all = await p.req.allHeaders();
    const names = Object.keys(all).map((n) => n.toLowerCase()).sort();
    const headers: Record<string, string> = {};
    for (const n of names) if (n === "content-type" || n.startsWith("x-")) headers[n] = all[n];
    const raw = p.req.postData();
    if (raw == null) throw new Error(`${d.id}, действие ${p.action}: у POST /api/chat нет тела`);
    requests.push({ action: p.action, headers, headerNames: names, body: JSON.parse(raw) as unknown });
  }
  if (errors.length) throw new Error(`${d.id}: ошибки страницы: ${errors.slice(0, 3).join(" | ")}`);
  await ctx.close();
  return { id: d.id, title: d.title, recorded: meta, actions: d.actions, requests };
}

/* ───── сводка для человека: реплика пользователя и что ответил сервер (по телу следующего запроса не видно последнего ответа) ───── */
type Msg = { role?: string; parts?: Array<{ type?: string; text?: string }> };
const userText = (body: unknown): string => {
  const ms = ((body as { messages?: Msg[] }).messages ?? []).filter((m) => m.role === "user");
  return (ms[ms.length - 1]?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ");
};

async function main(): Promise<void> {
  const base = opt("--base");
  if (!base) die(2, "нужен --base http://127.0.0.1:<порт> (сервер apps/web в режиме MOCK)");
  const out = path.resolve(process.cwd(), opt("--out") ?? "apps/web/audit/fixtures/dialogs");
  const only = opt("--only")?.split(",").map((s) => s.trim()).filter(Boolean);

  // Защита от живого сервера: запись тратила бы бюджет и давала бы недетерминированный эталон
  const h = (await fetch(new URL("/api/health", base)).then((r) => r.json()).catch(() => null)) as { mode?: string; jev?: unknown } | null;
  if (h?.mode !== "mock") die(2, `${base} отвечает mode=${h?.mode ?? "нет ответа"}, а не mock — запустите сервер с ${MODE} без ключей LLM/Jev`);
  if (h.jev != null) die(2, `${base}: Jev включён (${JSON.stringify(h.jev)}) — нужен JEV_ENABLED=0, эталон пишется на правилах`);

  const selected = DIALOGS.filter((d) => !only || only.includes(d.id));
  if (!selected.length) die(2, `нет диалогов по --only ${only?.join(",")}`);

  // Полный Chromium (новый headless), а не headless shell: ближе к настоящему браузеру. Нет его — headless shell.
  const browser = await chromium.launch({ channel: "chromium" }).catch(() => chromium.launch());
  const meta: DialogFixture["recorded"] = {
    commit: opt("--commit") ?? gitShortHead(),
    date: opt("--date") ?? new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10),
    mode: MODE,
    browser: `Chromium ${browser.version()}`,
    via: "playwright, реальный UI assistant-ui",
  };
  fs.mkdirSync(out, { recursive: true });
  let total = 0;
  try {
    for (const d of selected) {
      const fx = await recordDialog(browser, base, d, meta);
      fs.writeFileSync(path.join(out, `${d.id}.json`), JSON.stringify(fx, null, 1) + "\n");
      total += fx.requests.length;
      console.log(`${d.id}: ${fx.requests.length} запросов — ${fx.requests.map((r) => `[${r.action}] «${userText(r.body)}»`).join(", ")}`);
    }
  } finally {
    await browser.close();
  }
  console.log(`записано: ${selected.length} диалогов, ${total} запросов → ${path.relative(process.cwd(), out) || "."}`);
}

const isMain = (() => {
  try { return fs.realpathSync(path.resolve(process.argv[1] ?? "")) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
