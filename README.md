# trillix

[![CI](https://github.com/ka-shmd/trillix/actions/workflows/ci.yml/badge.svg)](https://github.com/ka-shmd/trillix/actions/workflows/ci.yml)

SaaS-конструктор форм (аналог Tally), MVP. Go (stdlib-first) + PostgreSQL 16 + React/TypeScript.
Монорепозиторий: Go-API в `cmd/` и `internal/`, кабинет в `web/app`, публичный рендерер в
`web/renderer`, миграции в `migrations/`, инфраструктура в `deploy/`.

Репозиторий: `github.com/ka-shmd/trillix` (он же module path).

Документация — в `docs/`: **[STATUS](docs/STATUS.md) (что верно прямо сейчас — начинать отсюда)**,
[ARCHITECTURE](docs/ARCHITECTURE.md) (как устроено и почему),
[DEV-PLAN](docs/DEV-PLAN.md) (что делаем и когда), [PROCESS](docs/PROCESS.md) (как работаем),
[JOURNAL](docs/JOURNAL.md) (что уже сделано — append-only, читается грепом),
[BACKLOG](docs/BACKLOG.md) (очередь задач вне плана).

**Разработка ведётся агентами Claude Code. Как с ними работать — [AGENTS-GUIDE](docs/AGENTS-GUIDE.md):**
какие хуки, скиллы, субагенты и команды установлены, что проверяется автоматически, что
остаётся на человеке и что делать, когда кажется, что агент идёт не туда.
Справочники по реализованному: [API](docs/API.md) (эндпоинты, тела, коды ошибок),
[SCHEMA](docs/SCHEMA.md) (таблицы, ключи, индексы) — производные от кода, правятся вместе с ним.

## Требования

- Go 1.26+ (см. `go.mod`)
- Node.js 20+ и npm (фронты `web/app`, `web/renderer`; e2e — `e2e/`)
- Docker + Docker Compose (Postgres в dev; весь стек в prod-local)
- [golangci-lint](https://golangci-lint.run) v2 — для `make lint`

## Текущий статус

**Фаза 9 закрыта — продукт живой на https://app.trillix.ru (кабинет) и https://f.trillix.ru (формы).**
Следующая — фаза 10 «Эксплуатационная зрелость».

Полное состояние на одной странице — **[docs/STATUS.md](docs/STATUS.md)**: что живо и где, состав
системы, открытый долг, хвосты за которыми следить. История закрытых фаз — [docs/JOURNAL.md](docs/JOURNAL.md).

`main` защищён: изменения идут через PR с зелёным CI (джобы `docs`, `go`, `web (app)`, `web (renderer)`).

Требуется также `jq` — на нём работают проверки документов (`make check-docs`) и хуки в `scripts/hooks/`.

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

`web/app` проксирует `/api` на Go-сервер `:8080`, `web/renderer` — `/public` (в dev CORS не нужен).
Кабинет — вход, дашборд и slash-редактор форм; рендерер — публичная форма по `/r/{slug}`.

## Команды

`make help` — полный список. Основные:

| Цель            | Что делает                                             |
|-----------------|--------------------------------------------------------|
| `make dev`      | Поднять Postgres и запустить API                       |
| `make db-up`    | Поднять только Postgres в Docker                       |
| `make db-down`  | Погасить Postgres (данные остаются в volume `pg_data`) |
| `make migrate-up` / `make migrate-down` | Применить все миграции / откатить последнюю |
| `make test`     | Go (`-race`, вкл. интеграционные в testcontainers) + vitest обоих фронтов |
| `make lint`     | `golangci-lint run` + eslint/tsc обоих фронтов          |
| `make seed`     | Демо-данные: пользователь `demo@trillix.local` / `demo-password` + 60 форм |
| `make prod-local` | Репетиция прода: собрать образ + статику, поднять весь стек под https на `*.localhost`, smoke |
| `make prod-local-down` | Погасить prod-local (тома с данными остаются)      |
| `make prod-local-trust` | Доверить локальный CA Caddy — настоящий «замочек» (sudo) |

Раннер миграций встроен в бинарник: `api migrate up` / `api migrate down` (в проде — та же
init-команда). Остановка сервера — SIGINT/SIGTERM (Ctrl+C): активные запросы дорабатываются
(потолок 15 с).

### Прод-контур и e2e

Репетиция прода на своей машине (distroless-образ, Caddy, https):

```sh
cp .env.prod-local .env   # опционально; make prod-local и так берёт .env.prod-local
make prod-local           # собрать образ + статику, поднять стек; в конце — smoke
# https://app.localhost (кабинет) · https://f.localhost/r/{slug} (форма)
make prod-local-trust     # разово: доверить локальный CA Caddy → «замочек» (sudo)
```

Сквозной Playwright-e2e против поднятого prod-local (единственное, что проверяет **собранный**
продукт в браузере — ловит баги «прод ≠ dev»):

```sh
cd e2e && npm ci && npx playwright install chromium   # один раз
npm test
```

Подробности — [e2e/README.md](e2e/README.md). Гаси стек: `make prod-local-down`.

### Переменные окружения

| Переменная          | Обязательна | Описание                                                        |
|---------------------|-------------|-----------------------------------------------------------------|
| `HTTP_ADDR`         | да          | Адрес HTTP-сервера, напр. `127.0.0.1:8080`                       |
| `POSTGRES_USER`     | да          | Роль Postgres (читает compose при создании контейнера)          |
| `POSTGRES_PASSWORD` | да          | Пароль роли Postgres                                            |
| `POSTGRES_DB`       | да          | Имя базы Postgres                                               |
| `DATABASE_URL`      | да          | DSN подключения к БД (сервер и раннер миграций)                 |

Это подмножество для dev. **Полный список с описанием каждой переменной — в
[`.env.example`](.env.example)** (источник истины): туда входят `COOKIE_SECURE`,
`FORM_TOKEN_SECRET`, `PUBLIC_RENDERER_BASE_URL`/`_INDEX_PATH`, `OG_IMAGE_URL`,
`APP_ORIGIN` (CSRF), домены Caddy `APP_DOMAIN`/`RENDERER_DOMAIN` и build-time `VITE_PUBLIC_BASE_URL`.
Различия контуров живут только в значениях: `.env.dev` (http, localhost) vs `.env.prod-local`
(https, `*.localhost`, `COOKIE_SECURE=true`) — приложение одно, ветвления по контуру в коде нет.
