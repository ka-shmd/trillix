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

**Фаза 3 «Билдер» завершена.** Редактор формы из блоков семи типов с автосохранением и живым превью.
Контракт схемы (Zod `FormSchema`/`Block` в `web/shared/entities` ↔ зеркальные Go-типы + `ValidateSchema`
с лимитами), `PATCH /forms/{id}` с оптимистичной блокировкой по `updated_at` (расхождение → 409),
zustand-стор билдера (add/update/remove/move/duplicate, покрыт vitest). Фронт: трёхколоночный экран
(палитра / канвас / панель настроек), инлайн-правка label/description, редактор опций choice, автосейв
(дебаунс 800 мс → PATCH всей схемы; индикатор статуса, баннер конфликта, предупреждение при уходе),
кнопки перемещения/удаления блоков, переключатель «Редактор/Превью» с общими компонентами полей
(`web/shared/fields`, переиспользуются рендерером фазы 4). Дальше — фаза 4 (публикация и публичный
рендерер). Реализованное API и таблицы — в [docs/API.md](docs/API.md) и [docs/SCHEMA.md](docs/SCHEMA.md).

Ранее завершены: **фаза 2 «Формы как сущности (CRUD)»** (дашборд форм: CRUD за `RequireAuth` с анти-IDOR,
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
