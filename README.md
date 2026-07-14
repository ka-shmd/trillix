# trierra

[![CI](https://github.com/ka-shmd/trierra/actions/workflows/ci.yml/badge.svg)](https://github.com/ka-shmd/trierra/actions/workflows/ci.yml)

SaaS-конструктор форм (аналог Tally), MVP. Go (stdlib-first) + PostgreSQL 16 + React/TypeScript.
Монорепозиторий: Go-API в `cmd/` и `internal/`, кабинет в `web/app`, публичный рендерер в
`web/renderer`, миграции в `migrations/`, инфраструктура в `deploy/`.

Репозиторий: `github.com/ka-shmd/trierra` (он же module path).

Документация — в `docs/`: [ARCHITECTURE](docs/ARCHITECTURE.md) (как устроено и почему),
[DEV-PLAN](docs/DEV-PLAN.md) (что делаем и когда), [PROCESS](docs/PROCESS.md) (как работаем).
Справочники по реализованному: [API](docs/API.md) (эндпоинты, тела, коды ошибок),
[SCHEMA](docs/SCHEMA.md) (таблицы, ключи, индексы) — производные от кода, правятся вместе с ним.

## Требования

- Go 1.25+
- Node.js 20+ и npm (два фронта в `web/app` и `web/renderer`)
- Docker + Docker Compose (Postgres в dev-контуре)
- [golangci-lint](https://golangci-lint.run) v2 — для `make lint`

## Текущий статус

**Фаза 6.5 «Редактор в стиле Tally» завершена.** Кабинет переведён на Tailwind CSS v4 + shadcn/ui:
сайдбар-навигация, единый вид дашборда, таблицы ответов и экранов auth. Сборка формы — slash-редактор как
документное полотно: название первой строкой, «/» открывает меню типов полей (в т.ч. на уже набранном
тексте — он становится подписью), клавиатурная навигация (Enter/Backspace/стрелки), перетаскивание блоков
(dnd-kit), инлайн-опции choice и инлайн-контролы `required`/`description` у блока. Добавлен неотвечаемый блок
`text`, форма-уровневые `submitLabel` (текст кнопки) и `settings.placeholder` (подсказка поля) — расширения
контракта Zod↔Go с тестами; единый вид формы вынесен в `web/shared/fields` (редактор ↔ превью ↔ рендерер не
разъезжаются). Публикация переехала на страницу «Поделиться» (`/forms/$formId/share`): публичная ссылка с
копированием, предпросмотр карточки (зеркалит серверные OG-мета `/r/{slug}`) и управление публикацией
(перепубликация изменений, закрытие); клик по опубликованной форме в списке ведёт туда же. Временный билдер
фазы 3 заменён. Обновлённые контракт и таблицы — в [docs/API.md](docs/API.md) и
[docs/SCHEMA.md](docs/SCHEMA.md).

Ранее завершены: **фаза 6 «Просмотр ответов и экспорт»** (таблица ответов с курсорной подгрузкой и панелью
полного ответа, стриминговый CSV-экспорт, удаление ответа, счётчик на карточке; `submissions` из миграций
`0004`/`0005`), **фаза 5 «Приём ответов»** (публичный `POST /public/v1/forms/{slug}/submissions` с
защитами: `MaxBytesReader` 256 КБ → 413, антиспам honeypot + HMAC-время, rate limit по IP,
идемпотентность через клиентский `submission_id` + `ON CONFLICT DO NOTHING`, карта ошибок `block_id →
сообщение`; валидатор `ValidateAnswers` против конкретной версии — миграция `0004`, таблица `submissions`;
рендерер с авторетраем и экраном «Спасибо»), **фаза 4 «Публикация и публичный рендерер»** (публикация одной транзакцией в
иммутабельную `form_versions`, `GET /public/v1/forms/{slug}` со схемой опубликованной версии +
`Cache-Control`/`ETag` + HMAC-токен времени, HTML-страница `/r/{slug}` от Go с OG-мета; черновик/закрытая →
404 обоими путями; публичный рендерер на общих `web/shared/fields` с клиентской валидацией; бюджет бандла
95 КиБ gzip в CI), **фаза 3 «Билдер»** (редактор формы из блоков семи типов с автосохранением и живым
превью; контракт схемы Zod ↔ Go + `ValidateSchema`, `PATCH /forms/{id}` с оптимистичной блокировкой по
`updated_at`, zustand-стор билдера, общие компоненты полей `web/shared/fields`),
**фаза 2 «Формы как сущности (CRUD)»** (дашборд форм: CRUD за `RequireAuth` с анти-IDOR,
курсорная пагинация, `slug`, `make seed`; фронт — грид карточек, инлайн-переименование, удаление),
**фаза 1 «Аутентификация»** (регистрация/вход/сессия/выход, argon2id, cookie-сессии, CSRF, rate limit,
чистка сессий, экраны Login/Register) и **фаза 0 «Фундамент и CI»** (скелет монорепозитория, API-сервер,
Postgres в Docker, Makefile, раннер миграций, golangci-lint, два каркаса Vite, GitHub Actions).

`main` защищён: изменения идут через PR с зелёным CI (джобы `go`, `web (app)`, `web (renderer)`).

## Быстрый старт

```sh
cp .env.dev .env    # активный .env (в .gitignore); .env.example документирует каждую переменную
make dev            # поднять Postgres и запустить API на хосте
```

Проверка в другом терминале:

```sh
curl localhost:8080/healthz
# {"status":"ok"}
```

## Фронтенды

Два отдельных Vite-проекта. Первый запуск — установить зависимости в каждом:

```sh
cd web/app      && npm install && npm run dev   # кабинет:  http://localhost:5173
cd web/renderer && npm install && npm run dev   # рендерер: http://localhost:5174
```

`web/app` проксирует `/api` на Go-сервер `:8080` (в dev CORS не нужен). Кабинет — вход и дашборд форм;
рендерер пока рендерит строку текста (наполнится в фазе 4).

## Команды

`make help` — полный список. Основные:

| Цель            | Что делает                                             |
|-----------------|--------------------------------------------------------|
| `make dev`      | Поднять Postgres и запустить API                       |
| `make db-up`    | Поднять только Postgres в Docker                       |
| `make db-down`  | Погасить Postgres (данные остаются в volume `pg_data`) |
| `make migrate-up` / `make migrate-down` | Применить все миграции / откатить последнюю |
| `make test`     | `go test -race ./...`                                  |
| `make lint`     | `golangci-lint run` (govet, errcheck, staticcheck, gofumpt) |
| `make seed`     | Демо-данные: пользователь `demo@trierra.local` / `demo-password` + 60 форм |

Раннер миграций встроен в бинарник: `api migrate up` / `api migrate down` (в проде — та же
init-команда). Остановка сервера — SIGINT/SIGTERM (Ctrl+C): активные запросы дорабатываются
(потолок 15 с).

### Переменные окружения

| Переменная          | Обязательна | Описание                                                        |
|---------------------|-------------|-----------------------------------------------------------------|
| `HTTP_ADDR`         | да          | Адрес HTTP-сервера, напр. `127.0.0.1:8080`                       |
| `POSTGRES_USER`     | да          | Роль Postgres (читает compose при создании контейнера)          |
| `POSTGRES_PASSWORD` | да          | Пароль роли Postgres                                            |
| `POSTGRES_DB`       | да          | Имя базы Postgres                                               |
| `DATABASE_URL`      | да          | DSN подключения к БД (сервер и раннер миграций)                 |
