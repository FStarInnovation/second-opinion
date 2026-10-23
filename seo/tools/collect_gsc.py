#!/usr/bin/env python3
"""Сборщик Google Search Console для SEO-цикла: запросы и страницы за 28 дней (до даты −3, данные окончательные)
и за предыдущие 28 дней.

Окружение: GSC_SA_JSON (содержимое JSON-ключа сервисного аккаунта с доступом к ресурсу),
GSC_SITE (например sc-domain:mkt-second-opinion.ru или https://emitent.net/).
Нет переменных — выходит с кодом 0 и пишет «пропуск».
Зависимость: google-auth (pip install google-auth requests).
Результат: seo/data/gsc-<YYYY-MM-DD>.json (или --out).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request

SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"


def token_from_sa(info: dict) -> str:
    from google.oauth2 import service_account  # noqa: WPS433 — импорт только когда есть ключ
    import google.auth.transport.requests

    creds = service_account.Credentials.from_service_account_info(info, scopes=[SCOPE])
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def query(site: str, token: str, start: str, end: str, dims: list[str], limit: int = 1000) -> list[dict]:
    url = f"https://searchconsole.googleapis.com/webmasters/v3/sites/{urllib.parse.quote(site, safe='')}/searchAnalytics/query"
    body = json.dumps({"startDate": start, "endDate": end, "dimensions": dims, "rowLimit": limit, "dataState": "final"}).encode()
    req = urllib.request.Request(url, data=body, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        rows = json.load(r).get("rows", [])
    return [{"keys": x["keys"], "clicks": x["clicks"], "impressions": x["impressions"], "ctr": round(x["ctr"], 4), "position": round(x["position"], 2)} for x in rows]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    raw, site = os.environ.get("GSC_SA_JSON", ""), os.environ.get("GSC_SITE", "")
    if not raw or not site:
        print("Search Console: пропуск — нет GSC_SA_JSON или GSC_SITE")
        return 0
    token = token_from_sa(json.loads(raw))
    end = dt.date.today() - dt.timedelta(days=3)
    cur = ((end - dt.timedelta(days=27)).isoformat(), end.isoformat())
    pend = end - dt.timedelta(days=28)
    prev = ((pend - dt.timedelta(days=27)).isoformat(), pend.isoformat())
    res = {"source": "gsc", "site": site, "collected": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    for key, (s, e) in (("current", cur), ("previous", prev)):
        res[key] = {"period": [s, e], "by_query": query(site, token, s, e, ["query"]), "by_page": query(site, token, s, e, ["page"]),
                    "by_query_page": query(site, token, s, e, ["query", "page"], 2000)}
    out = a.out or os.path.join("seo", "data", f"gsc-{dt.date.today().isoformat()}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(res, fh, ensure_ascii=False, indent=1)
    clicks = sum(r["clicks"] for r in res["current"]["by_page"])
    print(f"Search Console: {out} — кликов {clicks} за {cur[0]}…{cur[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
