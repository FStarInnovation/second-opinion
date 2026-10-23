# seo/data — выгрузки текущего запуска

Workflow `seo-loop.yml` кладёт сюда:
- `webmaster-*.md` — из ветки `seo-data` (их пишет задача, читающая Вебмастер в Chrome владельца по понедельникам);
- `metrika-*.json` — `seo/tools/collect_metrika.py`;
- `gsc-*.json` — `seo/tools/collect_gsc.py`.

В git эти файлы не попадают (`seo/.gitignore`).
