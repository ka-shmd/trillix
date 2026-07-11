# trierra

SaaS-конструктор форм (аналог Tally), MVP. Go (stdlib-first) + PostgreSQL 16 + React/TypeScript.
Монорепозиторий: Go-API в `cmd/` и `internal/`, кабинет в `web/app`, публичный рендерер в
`web/renderer`, миграции в `migrations/`, инфраструктура в `deploy/`.

Репозиторий: `github.com/ka-shmd/trierra` (он же module path).

Документация — в `docs/`: [ARCHITECTURE](docs/ARCHITECTURE.md) (как устроено и почему),
[DEV-PLAN](docs/DEV-PLAN.md) (что делаем и когда), [PROCESS](docs/PROCESS.md) (как работаем).

## Требования

- Go 1.25+
- Node.js 20+ и npm (два фронта в `web/app` и `web/renderer`)
- Docker + Docker Compose (Postgres в dev-контуре)
- [golangci-lint](https://golangci-lint.run) v2 — для `make lint`

## Текущий статус

Фаза 0 «Фундамент и CI», шаги 1–6 выполнены: скелет монорепозитория, минимальный API-сервер,
Postgres в Docker, Makefile и раннер миграций, golangci-lint, два каркаса Vite (react-ts, strict TS,
eslint + prettier). CI появится на шаге 7.

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

`web/app` проксирует `/api` на Go-сервер `:8080` (в dev CORS не нужен). Пока оба рендерят строку текста.

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
| `make seed`     | Заглушка (наполнится в фазе 2)                          |

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
