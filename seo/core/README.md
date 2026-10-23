# Семантическое ядро

Одна папка на сайт: `seo/core/<сайт>/core.csv` и `README.md` рядом.

Колонки `core.csv`: cluster, query, demand, clicks, competition, intent, target, coverage, note.
- demand, clicks, competition — из Вебмастера, «Подбор запросов и анализ рынка (β)» (/efficiency/wordcraft/), за последний месяц; источник и дата — в README папки сайта.
- target — раздел страницы или новая страница, coverage — да / частично / нет.

Ядро собирает и обновляет субагент `seo-core` (см. `.claude/agents/seo-core.md`), когда в `seo/data/` появляется выгрузка запросов новее ядра.
