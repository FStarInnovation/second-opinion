/**
 * Версия кода (план WP-TG §4.3, §4.4, §7). deploy.sh пишет короткий sha в <appDir>/VERSION до рестарта; бот читает его один раз
 * при старте и сверяет с version локального /api/health запущенного сервера — так бот не ходит в сервер другой версии.
 */
import fs from "node:fs";
import path from "node:path";

/** <appDir>/VERSION без пробельных символов по краям; нет файла или пусто — "dev" (как health сервера) */
export function readVersion(appDir: string): string {
  try {
    return fs.readFileSync(path.join(appDir, "VERSION"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

/** version локального /api/health сервера; ok — совпала с mine. Сервер недоступен или поля нет — {ok:false, server:null} */
export async function checkServerVersion(f: typeof fetch, webUrl: string, mine: string): Promise<{ ok: boolean; server: string | null }> {
  try {
    const res = await f(`${webUrl.replace(/\/+$/, "")}/api/health`, { method: "GET", headers: { accept: "application/json" } });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return { ok: false, server: null }; }
    const j = (await res.json()) as { version?: unknown } | null;
    const server = j && typeof j.version === "string" ? j.version : null;
    return { ok: server !== null && server === mine, server };
  } catch {
    return { ok: false, server: null };
  }
}
