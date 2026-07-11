# Единая точка входа. Значения окружения берутся из .env (cp .env.dev .env).

COMPOSE := docker compose --env-file .env -f compose.dev.yml

# Явный список Go-пакетов: `./...` заполз бы в web/**/node_modules, где npm-пакеты
# приносят посторонние .go-файлы (напр. flatted). Go не умеет игнорировать node_modules.
GO_PKGS := ./cmd/... ./internal/... ./migrations/...

# Подгрузить .env в окружение рецептов, если он есть.
ifneq (,$(wildcard .env))
include .env
export
endif

.PHONY: help dev db-up db-down migrate-up migrate-down seed sqlc test test-go test-unit test-web lint lint-go lint-web

help: ## Показать список целей
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

dev: db-up ## Поднять Postgres и запустить API на хосте
	go run ./cmd/api

db-up: ## Поднять Postgres в Docker
	$(COMPOSE) up -d

db-down: ## Погасить Postgres (данные остаются в volume)
	$(COMPOSE) down

migrate-up: ## Применить все миграции
	go run ./cmd/api migrate up

migrate-down: ## Откатить последнюю миграцию
	go run ./cmd/api migrate down

seed: ## Наполнить БД демо-данными (пользователь demo@trierra.local / demo-password + 60 форм)
	go run ./cmd/api seed
	@echo "seed готов: вход demo@trierra.local / demo-password"

sqlc: ## Сгенерировать типобезопасный код доступа к БД из SQL (в internal/postgres)
	go tool sqlc generate

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
