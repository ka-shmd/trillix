# trierra

SaaS-конструктор форм (аналог Tally), MVP. Go (stdlib-first) + PostgreSQL 16 + React/TypeScript.
Монорепозиторий: Go-API в `cmd/` и `internal/`, кабинет в `web/app`, публичный рендерер в
`web/renderer`, миграции в `migrations/`, инфраструктура в `deploy/`.

Репозиторий: `github.com/ka-shmd/trierra` (он же module path).

Документация — в `docs/`: [ARCHITECTURE](docs/ARCHITECTURE.md) (как устроено и почему),
[DEV-PLAN](docs/DEV-PLAN.md) (что делаем и когда), [PROCESS](docs/PROCESS.md) (как работаем).

## Требования

- Go 1.25+
- Docker + Docker Compose (Postgres в dev-контуре)

## Текущий статус

Фаза 0 «Фундамент и CI», шаги 1–3 выполнены: скелет монорепозитория, минимальный API-сервер,
Postgres в Docker. `make`-команды ещё не заведены (шаг 4) — пока запуск напрямую через `go` и `docker compose`.

## Настройка окружения

Конфигурация — только из окружения. Скопируй шаблон dev-контура в активный `.env` (он в `.gitignore`):

```sh
cp .env.dev .env
```

`.env.example` документирует каждую переменную.

## Postgres (dev)

```sh
docker compose --env-file .env -f compose.dev.yml up -d   # поднять
docker compose -f compose.dev.yml down                    # погасить (данные — в volume pg_data)
```

База слушает только `127.0.0.1:5432`. Данные переживают перезапуск контейнера (named volume);
удалить их полностью — `docker compose -f compose.dev.yml down -v`.

## Запуск API локально

Без обязательных переменных процесс падает на старте с перечислением недостающих.

```sh
HTTP_ADDR=127.0.0.1:8080 go run ./cmd/api
```

Проверка:

```sh
curl localhost:8080/healthz
# {"status":"ok"}
```

Остановка — SIGINT/SIGTERM (Ctrl+C): сервер завершает активные запросы (потолок 15 с) и гасится.

### Переменные окружения

| Переменная          | Обязательна | Описание                                                        |
|---------------------|-------------|-----------------------------------------------------------------|
| `HTTP_ADDR`         | да          | Адрес HTTP-сервера, напр. `127.0.0.1:8080`                       |
| `POSTGRES_USER`     | да          | Роль Postgres (читает compose при создании контейнера)          |
| `POSTGRES_PASSWORD` | да          | Пароль роли Postgres                                            |
| `POSTGRES_DB`       | да          | Имя базы Postgres                                               |
| `DATABASE_URL`      | да¹         | DSN подключения к БД. ¹Читается приложением начиная с шага 4     |

## Тесты

```sh
go test -race ./...
```
