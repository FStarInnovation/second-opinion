"""Тесты харнеса на фикстурах (режим --dir, без сети). Запуск: python3 -m unittest test_seo_harness -v"""
import os
import unittest

import seo_harness as h

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = {
    "name": "example.test", "base_url": "https://example.test", "canonical_host": "example.test",
    "indexable": True, "pages": ["/"], "forbidden_hosts": ["wrong.test"], "metrika_id": "12345678",
    "min_text_chars": 1000, "require": {"llms_txt": True, "jsonld_types": ["Organization", "WebSite"]},
}


def run(folder):
    res = h.run_checks(CFG, h.Fetcher(CFG["base_url"], os.path.join(HERE, "fixtures", folder)))
    return {r.id: r for r in res}


class GoodSite(unittest.TestCase):
    def test_all_green_except_live_only(self):
        r = run("good")
        bad = {k: (v.status, v.detail) for k, v in r.items() if v.status not in ("GREEN", "SKIP")}
        self.assertEqual(bad, {})
        self.assertEqual(r["S.7"].status, "SKIP")  # 404 проверяется только вживую


class BadSite(unittest.TestCase):
    def setUp(self):
        self.r = run("bad")

    def test_expected_reds(self):
        for cid in ["S.2", "S.10", "S.11", "P.1", "P.2", "P.3", "P.4", "P.5", "P.7", "P.9", "P.10", "P.11", "S.9", "S.8"]:
            self.assertEqual(self.r[cid].status, "RED", f"{cid}: {self.r[cid].detail}")

    def test_canonical_foreign(self):
        self.assertIn("чужой адрес", self.r["P.5"].detail)

    def test_not_indexable_stand(self):
        cfg = dict(CFG, indexable=False)
        res = {x.id: x for x in h.run_checks(cfg, h.Fetcher(cfg["base_url"], os.path.join(HERE, "fixtures", "bad")))}
        self.assertEqual(res["S.2"].status, "GREEN")  # стенд закрыт, как задумано
        self.assertEqual(res["S.4"].status, "SKIP")


class Units(unittest.TestCase):
    def test_foreign_hits_word_boundary(self):
        hits = h.foreign_hits("https://emitent.com/ and emitent.net", ["emitent.com"])
        self.assertEqual(len(hits), 1)
        self.assertIn("emitent.com", hits[0])
        self.assertEqual(h.foreign_hits("myemitent.com", ["emitent.com"]), [])

    def test_baseline_exit(self):
        import json, tempfile
        cfg_path = os.path.join(tempfile.mkdtemp(), "c.json")
        json.dump(CFG, open(cfg_path, "w"))
        base = os.path.join(os.path.dirname(cfg_path), "b.json")
        d = os.path.join(HERE, "fixtures", "good")
        self.assertEqual(h.main([cfg_path, "--dir", d, "--json", "--write-baseline", base]), 0)
        self.assertEqual(h.main([cfg_path, "--dir", os.path.join(HERE, "fixtures", "bad"), "--json", "--baseline", base]), 1)


if __name__ == "__main__":
    unittest.main()
