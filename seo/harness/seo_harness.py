#!/usr/bin/env python3
"""SEO-харнес фабрики: проверки сайта со статусами GREEN / RED / ERROR / SKIP.

Контракт тот же, что у аудит-харнеса second-opinion (apps/web/audit):
  * каждая проверка утверждает ЖЕЛАЕМОЕ состояние; пока сайт не исправлен — RED;
  * guard — инвариант, который уже GREEN и не должен ломаться;
  * код выхода: 0 — нет RED/ERROR (или, с --baseline, нет ухудшений), 1 — есть, 2 — ошибка запуска.

Режимы:
  --live              сайт по HTTPS (base_url из конфига);
  --dir PATH          собранная статика (dist/) до выкладки: файлы читаются с диска, URL сайта → файл.

Запуск:
  python3 seo_harness.py sites/emitent.net.json --live
  python3 seo_harness.py sites/emitent.net.json --dir ../лендинг/dist --json
  python3 seo_harness.py sites/emitent.net.json --live --write-baseline baselines/emitent.net.json
  python3 seo_harness.py sites/emitent.net.json --live --baseline baselines/emitent.net.json

Только стандартная библиотека Python 3.9+.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field, asdict
from html.parser import HTMLParser
from typing import Callable, Optional

UA = "Mozilla/5.0 (compatible; FStar-SEO-Harness/1.0; +https://github.com/FStarInnovation)"
RANK = {"GREEN": 0, "SKIP": 0, "RED": 1, "ERROR": 2}
SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"


# ───────────────────────────── загрузка ресурсов ─────────────────────────────
@dataclass
class Resp:
    status: int
    ctype: str
    body: bytes
    url: str

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


class Fetcher:
    """Единая точка доступа к сайту: живой HTTPS или папка со сборкой."""

    def __init__(self, base_url: str, directory: Optional[str] = None, timeout: float = 20.0):
        self.base_url = base_url.rstrip("/")
        self.dir = os.path.abspath(directory) if directory else None
        self.timeout = timeout
        self.cache: dict[str, Resp] = {}

    @property
    def live(self) -> bool:
        return self.dir is None

    def get(self, path_or_url: str) -> Resp:
        url = path_or_url if path_or_url.startswith("http") else self.base_url + path_or_url
        if url in self.cache:
            return self.cache[url]
        r = self._get_live(url) if self.live else self._get_dir(url)
        self.cache[url] = r
        return r

    def _get_live(self, url: str) -> Resp:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as f:
                return Resp(f.status, f.headers.get("Content-Type", ""), f.read(), f.geturl())
        except urllib.error.HTTPError as e:
            return Resp(e.code, e.headers.get("Content-Type", "") if e.headers else "", e.read() or b"", url)

    def _get_dir(self, url: str) -> Resp:
        p = urllib.parse.urlparse(url)
        base_host = urllib.parse.urlparse(self.base_url).netloc
        if p.netloc and p.netloc != base_host:
            return Resp(0, "", b"", url)  # чужой хост в режиме папки не проверяется
        rel = urllib.parse.unquote(p.path).lstrip("/")
        cand = [rel] if rel and not rel.endswith("/") else [os.path.join(rel, "index.html")]
        if rel and "." not in os.path.basename(rel):
            cand.append(rel + ".html")
            cand.append(os.path.join(rel, "index.html"))
        for c in cand:
            fp = os.path.join(self.dir, c)
            if os.path.isfile(fp):
                with open(fp, "rb") as fh:
                    return Resp(200, _guess_type(fp), fh.read(), url)
        return Resp(404, "text/plain", b"", url)


def _guess_type(fp: str) -> str:
    ext = os.path.splitext(fp)[1].lower()
    return {
        ".html": "text/html", ".txt": "text/plain", ".xml": "application/xml", ".json": "application/json",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
        ".svg": "image/svg+xml", ".ico": "image/x-icon", ".css": "text/css", ".js": "text/javascript",
    }.get(ext, "application/octet-stream")


# ───────────────────────────── разбор HTML ─────────────────────────────
class Page(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.lang = ""
        self.title = ""
        self.metas: list[dict[str, str]] = []
        self.links: list[dict[str, str]] = []
        self.h1: list[str] = []
        self.imgs: list[dict[str, str]] = []
        self.jsonld: list[str] = []
        self.text_parts: list[str] = []
        self._in: list[str] = []
        self._script_type = ""
        self._buf = ""

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "html":
            self.lang = a.get("lang", "")
        elif tag == "meta":
            self.metas.append(a)
        elif tag == "link":
            self.links.append(a)
        elif tag == "img":
            self.imgs.append(a)
        elif tag == "script":
            self._script_type = a.get("type", "").lower()
        if tag in ("title", "h1", "script", "style", "noscript"):
            self._in.append(tag)
            self._buf = ""

    def handle_endtag(self, tag):
        if self._in and self._in[-1] == tag:
            self._in.pop()
            if tag == "title":
                self.title = _norm(self._buf)
            elif tag == "h1":
                self.h1.append(_norm(self._buf))
            elif tag == "script" and self._script_type == "application/ld+json":
                self.jsonld.append(self._buf)
            self._buf = ""

    def handle_data(self, data):
        if self._in:
            self._buf += data
            if self._in[-1] == "h1":
                self.text_parts.append(data)
        else:
            self.text_parts.append(data)

    # удобные выборки
    def meta(self, key: str, attr: str = "name") -> Optional[str]:
        for m in self.metas:
            if m.get(attr, "").lower() == key.lower():
                return m.get("content", "")
        return None

    def link(self, rel: str) -> Optional[str]:
        for l in self.links:
            if rel in l.get("rel", "").lower().split():
                return l.get("href", "")
        return None

    @property
    def text(self) -> str:
        return _norm(" ".join(self.text_parts))


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def parse_page(html: str) -> Page:
    p = Page()
    p.feed(html)
    p.close()
    return p


# ───────────────────────────── проверки ─────────────────────────────
@dataclass
class Verdict:
    ok: bool
    detail: str
    skip: bool = False


@dataclass
class Check:
    id: str
    title: str
    group: str
    run: Callable[["Ctx"], Verdict]
    guard: bool = False
    live_only: bool = False


@dataclass
class Result:
    id: str
    group: str
    title: str
    status: str
    detail: str
    guard: bool = False
    ms: int = 0


@dataclass
class Ctx:
    cfg: dict
    f: Fetcher
    pages: dict[str, Page] = field(default_factory=dict)

    @property
    def host(self) -> str:
        return self.cfg["canonical_host"]

    @property
    def indexable(self) -> bool:
        return bool(self.cfg.get("indexable", True))

    def page(self, path: str) -> Page:
        if path not in self.pages:
            r = self.f.get(path)
            if r.status != 200:
                raise RuntimeError(f"{path}: HTTP {r.status}")
            self.pages[path] = parse_page(r.text)
        return self.pages[path]


def ok(d: str) -> Verdict:
    return Verdict(True, d)


def bad(d: str) -> Verdict:
    return Verdict(False, d)


def skip(d: str) -> Verdict:
    return Verdict(True, d, skip=True)


def host_of(url: str) -> str:
    return urllib.parse.urlparse(url).netloc.lower()


def urls_in(text: str) -> list[str]:
    return re.findall(r"https?://[^\s\"'<>)\]]+", text)


def foreign_hits(text: str, forbidden: list[str]) -> list[str]:
    hits = []
    for h in forbidden:
        for m in re.finditer(r"(?<![\w.-])" + re.escape(h) + r"(?![\w-])", text, re.I):
            hits.append(text[max(0, m.start() - 30): m.end() + 10].replace("\n", " "))
    return hits


# ── сайт целиком ──
def c_home(ctx: Ctx) -> Verdict:
    r = ctx.f.get("/")
    return ok("главная 200") if r.status == 200 else bad(f"главная HTTP {r.status}")


def c_robots(ctx: Ctx) -> Verdict:
    r = ctx.f.get("/robots.txt")
    if r.status != 200:
        return bad(f"/robots.txt HTTP {r.status}")
    blocks = re.split(r"(?im)^\s*user-agent\s*:", r.text)
    star_disallow_all = False
    for b in blocks[1:]:
        lines = b.splitlines()
        agent = lines[0].strip() if lines else ""
        if agent == "*" and re.search(r"(?im)^\s*disallow\s*:\s*/\s*$", b):
            star_disallow_all = True
    if ctx.indexable:
        return bad("robots.txt закрывает сайт для всех (Disallow: /)") if star_disallow_all else ok("robots.txt открыт")
    return ok("тестовый стенд закрыт (Disallow: /) — как задумано") if star_disallow_all else bad("сайт помечен неиндексируемым, но robots.txt его не закрывает")


def c_robots_sitemap(ctx: Ctx) -> Verdict:
    if not ctx.indexable:
        return skip("сайт не индексируется — строка Sitemap не требуется")
    r = ctx.f.get("/robots.txt")
    lines = re.findall(r"(?im)^\s*sitemap\s*:\s*(\S+)", r.text) if r.status == 200 else []
    if not lines:
        return bad("в robots.txt нет строки Sitemap")
    wrong = [u for u in lines if host_of(u) != ctx.host or not u.startswith("https://")]
    return bad(f"Sitemap указывает не на https://{ctx.host}: {wrong}") if wrong else ok(f"Sitemap: {lines[0]}")


def _sitemap_locs(ctx: Ctx) -> tuple[Optional[list[str]], str]:
    r = ctx.f.get("/sitemap.xml")
    if r.status != 200:
        return None, f"/sitemap.xml HTTP {r.status}"
    try:
        root = ET.fromstring(r.body)
    except ET.ParseError as e:
        return None, f"sitemap.xml не разбирается как XML: {e}"
    if not root.tag.endswith("urlset") and not root.tag.endswith("sitemapindex"):
        return None, f"корень sitemap.xml — {root.tag}, ожидался urlset"
    locs = [el.text.strip() for el in root.iter(SITEMAP_NS + "loc") if el.text]
    return locs, ""


def c_sitemap(ctx: Ctx) -> Verdict:
    if not ctx.indexable:
        return skip("сайт не индексируется")
    locs, err = _sitemap_locs(ctx)
    if locs is None:
        return bad(err)
    return ok(f"{len(locs)} адресов") if locs else bad("sitemap.xml пуст")


def c_sitemap_host(ctx: Ctx) -> Verdict:
    if not ctx.indexable:
        return skip("сайт не индексируется")
    locs, err = _sitemap_locs(ctx)
    if not locs:
        return bad(err or "нет адресов")
    wrong = [u for u in locs if host_of(u) != ctx.host or not u.startswith("https://")]
    return bad(f"адреса не на https://{ctx.host}: {wrong[:5]}") if wrong else ok("все адреса на своём домене")


def c_sitemap_200(ctx: Ctx) -> Verdict:
    if not ctx.indexable:
        return skip("сайт не индексируется")
    locs, err = _sitemap_locs(ctx)
    if not locs:
        return bad(err or "нет адресов")
    own = [u for u in locs if host_of(u) == ctx.host][:50]
    if not own:
        return bad("нет адресов своего домена")
    broken = [(u, ctx.f.get(u).status) for u in own if ctx.f.get(u).status != 200]
    return bad(f"не 200: {broken[:5]}") if broken else ok(f"{len(own)} адресов отвечают 200")


def c_404(ctx: Ctx) -> Verdict:
    if not ctx.f.live:
        return skip("ответ сервера на несуществующий адрес проверяется только на живом сайте")
    r = ctx.f.get("/__seo-harness-not-found-check")
    return ok("несуществующий адрес → 404") if r.status == 404 else bad(f"несуществующий адрес → HTTP {r.status} (мягкая 404)")


def c_favicon(ctx: Ctx) -> Verdict:
    p = ctx.page("/")
    href = p.link("icon") or p.link("shortcut")
    targets = ([href] if href else []) + ["/favicon.ico"]
    for t in targets:
        u = urllib.parse.urljoin(ctx.f.base_url + "/", t)
        r = ctx.f.get(u)
        if r.status == 200 and (r.ctype.startswith("image/") or t.endswith((".ico", ".svg", ".png"))) and not r.body.lstrip().lower().startswith(b"<!doctype"):
            return ok(f"иконка: {t}")
    return bad("нет рабочей иконки: <link rel=icon> не задан или /favicon.ico отдаёт не картинку")


def c_llms(ctx: Ctx) -> Verdict:
    if not ctx.cfg.get("require", {}).get("llms_txt", True):
        return skip("llms.txt не требуется конфигом")
    r = ctx.f.get("/llms.txt")
    if r.status != 200 or r.body.lstrip().lower().startswith(b"<!doctype"):
        return bad(f"/llms.txt HTTP {r.status}" if r.status != 200 else "/llms.txt отдаёт HTML")
    own = [u for u in urls_in(r.text) if host_of(u) == ctx.host]
    return ok(f"llms.txt есть, ссылок на свой домен: {len(own)}") if own else bad("в llms.txt нет ни одной ссылки на свой домен")


def c_forbidden(ctx: Ctx) -> Verdict:
    forb = ctx.cfg.get("forbidden_hosts", [])
    if not forb:
        return skip("запрещённые домены не заданы")
    found = []
    for path in ["/", "/robots.txt", "/sitemap.xml", "/llms.txt"] + ctx.cfg.get("pages", []):
        r = ctx.f.get(path)
        if r.status == 200:
            hits = foreign_hits(r.text, forb)
            if hits:
                found.append(f"{path}: {len(hits)}× «{hits[0]}»")
    return bad("чужой домен в файлах сайта — " + "; ".join(dict.fromkeys(found))) if found else ok("чужих доменов нет")


def c_metrika(ctx: Ctx) -> Verdict:
    cid = str(ctx.cfg.get("metrika_id") or "")
    html = ctx.f.get("/").text
    ids = set(re.findall(r"ym\(\s*(\d{5,})", html)) | set(re.findall(r"mc\.yandex\.ru/watch/(\d{5,})", html))
    if not cid:
        return bad("номер счётчика Метрики не задан в конфиге" + (f"; на странице найден {sorted(ids)}" if ids else "; счётчика на странице нет"))
    return ok(f"счётчик {cid} на месте") if cid in ids else bad(f"счётчика {cid} на главной нет (найдено: {sorted(ids) or '—'})")


def c_verification(ctx: Ctx) -> Verdict:
    p = ctx.page("/")
    have = [k for k in ("yandex-verification", "google-site-verification") if p.meta(k) is not None]
    return ok(f"мета-теги подтверждения: {have}") if have else skip("мета-тегов подтверждения нет (права могли подтвердить через DNS или файл)")


# ── страницы ──
def per_page(fn: Callable[[Ctx, str, Page], Verdict]) -> Callable[[Ctx], Verdict]:
    def run(ctx: Ctx) -> Verdict:
        bads, oks = [], []
        for path in ctx.cfg.get("pages", ["/"]):
            v = fn(ctx, path, ctx.page(path))
            (oks if v.ok else bads).append(f"{path}: {v.detail}")
        return bad("; ".join(bads)) if bads else ok("; ".join(oks))
    return run


def p_title(ctx, path, p):
    n = len(p.title)
    if not p.title:
        return bad("нет <title>")
    return ok(f"{n} знаков") if 15 <= n <= 70 else bad(f"длина title {n} (норма 15–70): «{p.title}»")


def p_description(ctx, path, p):
    d = p.meta("description")
    if not d:
        return bad("нет meta description")
    n = len(d)
    return ok(f"{n} знаков") if 50 <= n <= 170 else bad(f"длина description {n} (норма 50–170)")


def p_h1(ctx, path, p):
    return ok(f"«{p.h1[0][:60]}»") if len(p.h1) == 1 and p.h1[0] else bad(f"H1 на странице: {len(p.h1)} (нужен ровно один)")


def p_lang(ctx, path, p):
    want = ctx.cfg.get("lang", "ru")
    return ok(p.lang) if p.lang.lower().startswith(want) else bad(f"<html lang=\"{p.lang}\">, ожидался {want}")


def p_canonical(ctx, path, p):
    c = p.link("canonical")
    if not c:
        return bad("нет <link rel=canonical>")
    u = urllib.parse.urlparse(c)
    if not c.startswith("https://") or u.netloc.lower() != ctx.host:
        return bad(f"canonical ведёт на чужой адрес: {c}")
    want = path.rstrip("/") or "/"
    got = u.path.rstrip("/") or "/"
    return ok(c) if want == got else bad(f"canonical {c} не совпадает со страницей {path}")


def p_noindex(ctx, path, p):
    r = (p.meta("robots") or "").lower()
    if not ctx.indexable:
        return ok("стенд не индексируется")
    return bad(f"meta robots: {r}") if "noindex" in r else ok(r or "meta robots нет — по умолчанию index")


def p_og(ctx, path, p):
    need = ["og:title", "og:description", "og:image", "og:url"]
    miss = [k for k in need if not p.meta(k, "property")]
    if miss:
        return bad(f"нет {', '.join(miss)}")
    url = p.meta("og:url", "property") or ""
    return bad(f"og:url на чужом домене: {url}") if host_of(url) != ctx.host else ok("og:title/description/image/url")


def p_og_image(ctx, path, p):
    img = p.meta("og:image", "property")
    if not img:
        return bad("нет og:image")
    u = urllib.parse.urljoin(ctx.f.base_url + "/", img)
    if host_of(u) != ctx.host:
        return bad(f"og:image на чужом домене: {img}")
    r = ctx.f.get(u)
    return ok(img) if r.status == 200 and r.ctype.startswith("image/") else bad(f"og:image {img}: HTTP {r.status} {r.ctype}")


def p_jsonld(ctx, path, p):
    if not p.jsonld:
        return bad("нет разметки schema.org (JSON-LD)")
    types, wrong = [], []
    for raw in p.jsonld:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            return bad(f"JSON-LD не разбирается: {e}")
        def walk(o):
            if isinstance(o, dict):
                t = o.get("@type")
                if t:
                    types.extend(t if isinstance(t, list) else [t])
                for k, v in o.items():
                    if k in ("url", "@id", "logo", "image", "item", "contentUrl") and isinstance(v, str) and v.startswith("http"):
                        if host_of(v) not in [ctx.host] + ctx.cfg.get("allowed_hosts", []):
                            wrong.append(f"{k}={v}")
                    walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)
        walk(data)
    need = ctx.cfg.get("require", {}).get("jsonld_types", [])
    miss = [t for t in need if t not in types]
    if wrong:
        return bad(f"адреса в JSON-LD на чужом домене: {wrong[:4]}")
    if miss:
        return bad(f"нет типов {miss}; есть {sorted(set(types))}")
    return ok(f"типы: {sorted(set(types))}")


def p_img_alt(ctx, path, p):
    imgs = [i for i in p.imgs if "aria-hidden" not in i and i.get("role") != "presentation"]
    miss = [i.get("src", "")[:40] for i in imgs if "alt" not in i]
    return bad(f"без alt: {len(miss)} из {len(imgs)} ({miss[:3]})") if miss else ok(f"картинок {len(imgs)}, у всех есть alt")


def p_text(ctx, path, p):
    n = len(p.text)
    lim = int(ctx.cfg.get("min_text_chars", 1500))
    return ok(f"{n} знаков текста") if n >= lim else bad(f"мало текста в HTML от сервера: {n} знаков (порог {lim})")


CHECKS: list[Check] = [
    Check("S.1", "Главная отвечает 200", "сайт", c_home, guard=True),
    Check("S.2", "robots.txt соответствует статусу сайта", "сайт", c_robots),
    Check("S.3", "В robots.txt есть Sitemap на своём домене", "сайт", c_robots_sitemap),
    Check("S.4", "sitemap.xml есть и разбирается", "сайт", c_sitemap),
    Check("S.5", "Все адреса sitemap — на своём домене", "сайт", c_sitemap_host),
    Check("S.6", "Адреса sitemap отвечают 200", "сайт", c_sitemap_200),
    Check("S.7", "Несуществующий адрес отдаёт 404", "сайт", c_404, live_only=True),
    Check("S.8", "Есть рабочая иконка сайта", "сайт", c_favicon),
    Check("S.9", "llms.txt есть и ссылается на свой домен", "сайт", c_llms),
    Check("S.10", "В файлах сайта нет запрещённых доменов", "сайт", c_forbidden),
    Check("S.11", "Счётчик Метрики стоит на главной", "сайт", c_metrika),
    Check("S.12", "Мета-теги подтверждения прав (справочно)", "сайт", c_verification),
    Check("P.1", "Title 15–70 знаков", "страницы", per_page(p_title)),
    Check("P.2", "Description 50–170 знаков", "страницы", per_page(p_description)),
    Check("P.3", "Ровно один H1", "страницы", per_page(p_h1)),
    Check("P.4", "html lang = ru", "страницы", per_page(p_lang), guard=True),
    Check("P.5", "Canonical на своём домене и на эту же страницу", "страницы", per_page(p_canonical)),
    Check("P.6", "Нет noindex у индексируемых страниц", "страницы", per_page(p_noindex), guard=True),
    Check("P.7", "Open Graph: title, description, image, url", "страницы", per_page(p_og)),
    Check("P.8", "og:image отдаётся картинкой", "страницы", per_page(p_og_image)),
    Check("P.9", "JSON-LD разбирается, адреса на своём домене, нужные типы есть", "страницы", per_page(p_jsonld)),
    Check("P.10", "У картинок есть alt", "страницы", per_page(p_img_alt)),
    Check("P.11", "Текст виден в HTML от сервера", "страницы", per_page(p_text)),
]


# ───────────────────────────── запуск ─────────────────────────────
def run_checks(cfg: dict, f: Fetcher, only: Optional[list[str]] = None) -> list[Result]:
    ctx = Ctx(cfg, f)
    out = []
    for c in CHECKS:
        if only and c.id not in only and c.group not in only:
            continue
        t0 = time.time()
        if c.live_only and not f.live:
            out.append(Result(c.id, c.group, c.title, "SKIP", "только для живого сайта", c.guard, 0))
            continue
        try:
            v = c.run(ctx)
            st = "SKIP" if v.skip else ("GREEN" if v.ok else "RED")
            out.append(Result(c.id, c.group, c.title, st, v.detail, c.guard, int((time.time() - t0) * 1000)))
        except Exception as e:  # noqa: BLE001 — любая ошибка проверки = ERROR, а не падение харнеса
            out.append(Result(c.id, c.group, c.title, "ERROR", f"{type(e).__name__}: {e}", c.guard, int((time.time() - t0) * 1000)))
    return out


def render_text(results: list[Result], cfg: dict, mode: str) -> str:
    lines = [f"SEO-харнес · {cfg['name']} · {mode}", ""]
    for r in results:
        mark = r.status + ("*" if r.guard else "")
        lines.append(f"{mark:<7} {r.id:<5} {r.title}")
        if r.status in ("RED", "ERROR"):
            lines.append(f"        └ {r.detail[:400]}")
    cnt = {s: sum(1 for r in results if r.status == s) for s in RANK}
    lines.append("")
    lines.append(f"Итого: GREEN {cnt['GREEN']} · RED {cnt['RED']} · ERROR {cnt['ERROR']} · SKIP {cnt['SKIP']}  ({len(results)} проверок; * = guard)")
    return "\n".join(lines)


def render_md(results: list[Result], cfg: dict, mode: str) -> str:
    cnt = {s: sum(1 for r in results if r.status == s) for s in RANK}
    head = f"### SEO-харнес · {cfg['name']} · {mode}\n\nGREEN {cnt['GREEN']} · RED {cnt['RED']} · ERROR {cnt['ERROR']} · SKIP {cnt['SKIP']}\n\n"
    rows = ["| ID | Статус | Проверка | Подробности |", "|---|---|---|---|"]
    for r in results:
        rows.append(f"| {r.id} | {r.status}{'*' if r.guard else ''} | {r.title} | {r.detail.replace('|', '/')[:300]} |")
    return head + "\n".join(rows) + "\n"


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="SEO-харнес фабрики")
    ap.add_argument("config", help="конфиг сайта (sites/*.json)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--live", action="store_true", help="проверять живой сайт")
    g.add_argument("--dir", help="проверять собранную статику в папке")
    ap.add_argument("--only", help="id или группы через запятую")
    ap.add_argument("--json", action="store_true", help="вывод JSON")
    ap.add_argument("--md", help="записать отчёт Markdown в файл")
    ap.add_argument("--write-baseline", metavar="FILE")
    ap.add_argument("--baseline", metavar="FILE", help="сравнить с базой: код 1 только при ухудшении")
    a = ap.parse_args(argv)

    with open(a.config, encoding="utf-8") as fh:
        cfg = json.load(fh)
    for k in ("name", "base_url", "canonical_host"):
        if k not in cfg:
            print(f"в конфиге нет поля {k}", file=sys.stderr)
            return 2
    f = Fetcher(cfg["base_url"], a.dir)
    mode = "живой сайт" if f.live else f"сборка {a.dir}"
    only = [s.strip() for s in a.only.split(",")] if a.only else None
    results = run_checks(cfg, f, only)

    if a.json:
        print(json.dumps([asdict(r) for r in results], ensure_ascii=False, indent=1))
    else:
        print(render_text(results, cfg, mode))
    if a.md:
        with open(a.md, "w", encoding="utf-8") as fh:
            fh.write(render_md(results, cfg, mode))

    if a.write_baseline:
        prev = {}
        if os.path.exists(a.write_baseline):
            with open(a.write_baseline, encoding="utf-8") as fh:
                prev = json.load(fh)
        prev.update({r.id: r.status for r in results})
        os.makedirs(os.path.dirname(os.path.abspath(a.write_baseline)), exist_ok=True)
        with open(a.write_baseline, "w", encoding="utf-8") as fh:
            json.dump(prev, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
        print(f"baseline записан: {a.write_baseline}", file=sys.stderr)

    if a.baseline:
        if not os.path.exists(a.baseline):
            print("нет baseline — сначала --write-baseline", file=sys.stderr)
            return 2
        with open(a.baseline, encoding="utf-8") as fh:
            base = json.load(fh)
        worse = [r for r in results if r.id in base and RANK[r.status] > RANK[base[r.id]]]
        better = [r for r in results if r.id in base and RANK[r.status] < RANK[base[r.id]]]
        if not a.json:
            if better:
                print("↑ стало лучше: " + ", ".join(f"{r.id} {base[r.id]}→{r.status}" for r in better))
            if worse:
                print("↓ ХУЖЕ базового: " + ", ".join(f"{r.id} {base[r.id]}→{r.status}" for r in worse))
        return 1 if worse else 0
    return 1 if any(r.status in ("RED", "ERROR") for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
