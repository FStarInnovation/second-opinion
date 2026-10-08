/**
 * Кэш шрифтов Geist для детерминированных скриншотов: CSS Google Fonts и woff2 скачиваются
 * один раз (через прокси окружения, TLS проверяется) и отдаются странице через page.route.
 * Нет сети — шрифты обрываются, страница рендерится системным шрифтом; это не ошибка валидатора.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Page } from "playwright";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
let dispatcherReady: Promise<void> | null = null;

async function ensureProxy() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return;
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  const caPath = process.env.NODE_EXTRA_CA_CERTS || "/root/.ccr/ca-bundle.crt";
  const ca = fs.existsSync(caPath) ? fs.readFileSync(caPath, "utf8") : undefined;
  setGlobalDispatcher(new ProxyAgent({ uri: proxy, requestTls: ca ? { ca } : undefined }));
}

const key = (url: string) => crypto.createHash("sha1").update(url).digest("hex").slice(0, 20);

export class FontCache {
  constructor(private dir: string) { fs.mkdirSync(dir, { recursive: true }); }
  status: "cache" | "network" | "unavailable" = "cache";

  private async get(url: string): Promise<{ body: Buffer; type: string } | null> {
    const f = path.join(this.dir, key(url));
    if (fs.existsSync(f + ".bin")) return { body: fs.readFileSync(f + ".bin"), type: fs.readFileSync(f + ".type", "utf8") };
    try {
      dispatcherReady ??= ensureProxy();
      await dispatcherReady;
      const r = await fetch(url, { headers: { "user-agent": UA } });
      if (!r.ok) throw new Error(String(r.status));
      const body = Buffer.from(await r.arrayBuffer());
      const type = r.headers.get("content-type") ?? "application/octet-stream";
      fs.writeFileSync(f + ".bin", body);
      fs.writeFileSync(f + ".type", type);
      if (this.status === "cache") this.status = "network";
      return { body, type };
    } catch {
      this.status = "unavailable";
      return null;
    }
  }

  async attach(page: Page) {
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
      const hit = await this.get(route.request().url());
      if (hit) await route.fulfill({ status: 200, body: hit.body, headers: { "content-type": hit.type, "access-control-allow-origin": "*" } });
      else await route.abort();
    });
  }
}
