#!/usr/bin/env python3
"""Сборщик Яндекс Метрики для SEO-цикла: последние 7 дней против предыдущих 7.

Окружение: YM_TOKEN (OAuth-токен с правом metrika:read), YM_COUNTER (номер счётчика).
Нет переменных — выходит с кодом 0 и пишет «пропуск» (цикл работает и без Метрики).
Результат: seo/data/metrika-<YYYY-MM-DD>.json (или --out).
Только стандартная библиотека.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.parse
import urllib.request

API = "https://api-metrika.yandex.net"
METRICS = "ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate,ym:s:avgVisitDurationSeconds"


def get(path: str, params: dict, token: str) -> dict:
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Authorization": f"OAuth {token}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def period(days_back_end: int, length: int) -> tuple[str, str]:
    end = dt.date.today() - dt.timedelta(days=days_back_end)
    start = end - dt.timedelta(days=length - 1)
    return start.isoformat(), end.isoformat()


def report(counter: str, token: str, d1: str, d2: str, dimensions: str | None, limit: int = 50) -> list[dict]:
    p = {"ids": counter, "metrics": METRICS, "date1": d1, "date2": d2, "limit": limit, "accuracy": "full"}
    if dimensions:
        p["dimensions"] = dimensions
    data = get("/stat/v1/data", p, token)
    names = [m.split(":")[-1] for m in METRICS.split(",")]
    rows = []
    for item in data.get("data", []):
        dims = [d.get("name") for d in item.get("dimensions", [])]
        rows.append({"dims": dims, **dict(zip(names, item.get("metrics", [])))})
    if not dimensions:
        rows = [{"dims": [], **dict(zip(names, data.get("totals", [])))}]
    return rows


def goals(counter: str, token: str, d1: str, d2: str) -> list[dict]:
    gl = get(f"/management/v1/counter/{counter}/goals", {}, token).get("goals", [])
    out = []
    for g in gl:
        m = f"ym:s:goal{g['id']}reaches"
        data = get("/stat/v1/data", {"ids": counter, "metrics": m, "date1": d1, "date2": d2}, token)
        out.append({"id": g["id"], "name": g.get("name"), "reaches": (data.get("totals") or [0])[0]})
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    token, counter = os.environ.get("YM_TOKEN", ""), os.environ.get("YM_COUNTER", "")
    if not token or not counter:
        print("Метрика: пропуск — нет YM_TOKEN или YM_COUNTER")
        return 0
    cur = period(1, 7)
    prev = period(8, 7)
    res = {"source": "metrika", "counter": counter, "collected": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
           "current": {"period": cur}, "previous": {"period": prev}}
    for key, (d1, d2) in (("current", cur), ("previous", prev)):
        res[key]["totals"] = report(counter, token, d1, d2, None)[0]
        res[key]["by_source"] = report(counter, token, d1, d2, "ym:s:lastTrafficSource", 20)
        res[key]["by_start_url"] = report(counter, token, d1, d2, "ym:s:startURL", 50)
        res[key]["by_search_engine"] = report(counter, token, d1, d2, "ym:s:lastSearchEngine", 20)
        try:
            res[key]["goals"] = goals(counter, token, d1, d2)
        except Exception as e:  # noqa: BLE001 — цели не обязательны
            res[key]["goals_error"] = str(e)
    out = a.out or os.path.join("seo", "data", f"metrika-{dt.date.today().isoformat()}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(res, fh, ensure_ascii=False, indent=1)
    t = res["current"]["totals"]
    print(f"Метрика: {out} — визиты {t.get('visits')} за {cur[0]}…{cur[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
