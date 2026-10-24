# seo/ — SEO-цикл second-opinion

Еженедельный цикл: данные → аудит → семантическое ядро → 1–2 правки в исходниках → независимая проверка → PR. Merge и выкладку делает владелец. Общая версия фабрики (для нескольких сайтов) лежит у владельца в `~/projects/Маркетинг/seo-factory/`.

## Что где
| Путь | Что |
|---|---|
| `seo/harness/seo_harness.py` | внешний харнес сайта: 23 проверки по живому сайту или по папке со сборкой (GREEN/RED/ERROR/SKIP, guard, база). Только стандартная библиотека Python. Тесты: `cd seo/harness && python3 -m unittest test_seo_harness` |
| `apps/web/audit/checks/wp-seo.ts` | харнес приложения WP-SEO (SEO.1–SEO.13): sitemap, robots, метаданные, canonical, картинки, JSON-LD, llms.txt, Метрика. `npm run -w @so/web audit -- --only SEO` |
| `seo/sites/mkt-second-opinion.ru.json` | конфиг сайта для внешнего харнеса (`indexable: false`, пока стенд закрыт) |
| `seo/baselines/` | база внешнего харнеса по живому сайту |
| `seo/tools/collect_metrika.py` | Метрика: 7 дней к 7 (секрет `YM_TOKEN`, переменная `YM_COUNTER`); адреса входа без параметров, в публичном репозитории цифры в лог не пишет |
| `seo/tools/collect_gsc.py` | Search Console: 28 дней к 28 (секрет `GSC_SA_JSON`, переменная `GSC_SITE`) |
| `seo/data/` | выгрузки текущего запуска; в git не хранятся (см. `.gitignore`). Вебмастер приходит из ветки `seo-data` |
| `seo/core/<сайт>/` | семантическое ядро (`core.csv`, `README.md`) |
| `seo/hypotheses.md` | журнал гипотез: правка → метрика → дата проверки |
| `seo/reports/` | отчёты по датам |
| `seo/LOOP.md` | инструкция оркестратору цикла |
| `.claude/agents/seo-*.md` | субагенты: auditor, core, editor, reviewer, reporter |
| `.github/workflows/seo-loop.yml` | цикл по понедельникам 09:17 МСК + ручной запуск. Claude коммитит локально без токена; push в `seo/*` и PR делает отдельный шаг и не пропускает правки `.github/`, `.claude/`, `deploy/`, robots, `.env` |
| `.github/workflows/seo-harness.yml` | проверка PR: typecheck, WP-SEO, тесты харнеса, сборка и внешний харнес по локальному серверу |

## Запуск вручную
```
python3 seo/harness/seo_harness.py seo/sites/mkt-second-opinion.ru.json --live
python3 seo/harness/seo_harness.py seo/sites/mkt-second-opinion.ru.json --live --baseline seo/baselines/mkt-second-opinion.ru.live.json
npm run -w @so/web audit -- --only SEO --baseline
AUDIT_LIVE=1 npm run -w @so/web audit -- --only SEO   # SEO.11–13 против прода
```

## Что нужно от владельца
- Секрет `ANTHROPIC_API_KEY` (Settings → Secrets and variables → Actions) — без него цикл не стартует.
- Settings → Actions → General → Workflow permissions: галка «Allow GitHub Actions to create and approve pull requests» — иначе цикл не сможет открыть PR (тогда он заведёт issue). Права на запись workflow задаёт сам.
- Settings → Branches: защитить `e2-blocks-page` и `main` (PR с ревью, без прямого push) — второй рубеж к правилам в workflow.
- Когда будет счётчик Метрики: `NEXT_PUBLIC_YM_ID` в `apps/web/.env` на сервере (включает счётчик), `YM_COUNTER` (переменная) и `YM_TOKEN` (секрет) в GitHub.
- Открыть сайт для поиска — `SO_PUBLIC=1` в `.env` на сервере и `indexable: true` в `seo/sites/mkt-second-opinion.ru.json`. Это решение владельца; цикл этого не делает.

## Правила цикла
Не больше двух правок за запуск; каждая — с гипотезой, метрикой и датой проверки в `seo/hypotheses.md`. Доступ поисковиков (robots, noindex, `SO_PUBLIC`), адреса страниц, формы, оплата — не трогаются. Факты и формулировки — только из исходников. Merge и выкладка — владелец.
