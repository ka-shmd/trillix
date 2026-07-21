# Единая точка входа. Значения окружения берутся из .env (cp .env.dev .env).

COMPOSE := docker compose --env-file .env -f compose.dev.yml

# prod-local контур: тот же образ/compose, что уедет на прод, но на *.localhost.
API_IMAGE    := ghcr.io/ka-shmd/trillix-api:latest
PROD_PROJECT := trillix-prod-local
# Профиль local-media поднимает MinIO+бутстрап бакета — они нужны только здесь:
# на проде хранилище арендованное, и эти сервисы не запускаются (deploy/compose.prod.yml).
PROD_COMPOSE := docker compose -p $(PROD_PROJECT) --profile local-media --env-file .env.prod-local -f deploy/compose.prod.yml

# Явный список Go-пакетов: `./...` заполз бы в web/**/node_modules, где npm-пакеты
# приносят посторонние .go-файлы (напр. flatted). Go не умеет игнорировать node_modules.
GO_PKGS := ./cmd/... ./internal/... ./migrations/...

# Подгрузить .env в окружение рецептов, если он есть.
ifneq (,$(wildcard .env))
include .env
export
endif

.PHONY: help dev dev-all dev-stop db-up db-down migrate-up migrate-down seed sqlc test test-go test-unit test-web lint lint-go lint-web prod-local prod-local-down prod-local-trust

help: ## Показать список целей
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

dev: db-up ## Поднять Postgres и запустить API на хосте
	go run ./cmd/api

dev-all: ## Весь dev-контур одной командой: Postgres + API + оба фронта (Ctrl-C — стоп)
	./scripts/dev-all.sh

dev-stop: ## Остановить API и фронты dev-all (по портам 8080/5173/5174)
	@for p in 8080 5173 5174; do \
		pids=$$(lsof -ti tcp:$$p 2>/dev/null || true); \
		if [ -n "$$pids" ]; then kill $$pids 2>/dev/null || true; echo "  :$$p остановлен ($$pids)"; \
		else echo "  :$$p свободен"; fi; \
	done

db-up: ## Поднять Postgres в Docker
	$(COMPOSE) up -d

db-down: ## Погасить Postgres (данные остаются в volume)
	$(COMPOSE) down

migrate-up: ## Применить все миграции
	go run ./cmd/api migrate up

migrate-down: ## Откатить последнюю миграцию
	go run ./cmd/api migrate down

seed: ## Наполнить БД демо-данными (demo@trillix.local / demo-password + 60 форм + CSV-демо с 2 версиями и 10k ответов)
	go run ./cmd/api seed
	@echo "seed готов: вход demo@trillix.local / demo-password"

sqlc: ## Сгенерировать типобезопасный код доступа к БД из SQL (в internal/postgres)
	go tool sqlc generate

# Важно: .env.prod-local источается в ТОТ ЖЕ шелл, где идёт compose/сборка.
# Makefile выше делает `include .env; export` (dev-значения для go run), а у docker
# compose переменные шелла приоритетнее --env-file — без source dev-DATABASE_URL
# (127.0.0.1) перекрыл бы prod-local. source в рецепте возвращает верный контур.
prod-local: ## Репетиция прода: собрать образ+статику, поднять стек под https на *.localhost, smoke
	docker build -f deploy/Dockerfile -t $(API_IMAGE) .
	set -a && . ./.env.prod-local && set +a && \
		./scripts/build-static.sh && $(PROD_COMPOSE) up -d
	./scripts/prod-local-smoke.sh $(PROD_PROJECT)

prod-local-down: ## Погасить prod-local (тома с данными сохраняются; -v сотрёт БД)
	set -a && . ./.env.prod-local && set +a && $(PROD_COMPOSE) down

prod-local-trust: ## Доверить локальный CA Caddy (даёт настоящий «замочек» на *.localhost; требует sudo)
	docker cp $(PROD_PROJECT)-caddy-1:/data/caddy/pki/authorities/local/root.crt /tmp/caddy-local-ca.crt
	sudo cp /tmp/caddy-local-ca.crt /usr/local/share/ca-certificates/caddy-local-ca.crt
	sudo update-ca-certificates
	@echo "Системный trust обновлён. Chrome/Chromium — перезапустить (берёт системный стор)."
	@echo "Firefox — свой стор: about:config → security.enterprise_roots.enabled=true (или импорт /tmp/caddy-local-ca.crt в Authorities)."

test: test-go test-web ## Все тесты: Go (юниты + интеграционные) и фронтовый vitest

test-go: ## Go с гонками; интеграционные (тег integration) — против testcontainers-Postgres (нужен Docker)
	go test -race -tags=integration $(GO_PKGS)

test-unit: ## Только быстрые Go-юниты без Docker (без интеграционных)
	go test -race $(GO_PKGS)

test-web: ## Фронтовые тесты (vitest в web/app и web/renderer)
	cd web/app && npm test
	cd web/renderer && npm test

lint: lint-go lint-web ## Все статические проверки: Go + оба фронта

lint-go: ## Go: golangci-lint (govet, errcheck, staticcheck, gofumpt)
	golangci-lint run $(GO_PKGS)

lint-web: ## Фронты: eslint + tsc (требует npm install в web/app и web/renderer)
	cd web/app && npm run lint && npm run typecheck
	cd web/renderer && npm run lint && npm run typecheck
