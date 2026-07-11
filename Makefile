# Единая точка входа. Значения окружения берутся из .env (cp .env.dev .env).
# Часть целей (полный lint, фронтовые тесты) наполнится на шагах 5–6.

COMPOSE := docker compose --env-file .env -f compose.dev.yml

# Подгрузить .env в окружение рецептов, если он есть.
ifneq (,$(wildcard .env))
include .env
export
endif

.PHONY: help dev db-up db-down migrate-up migrate-down seed test lint

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

seed: ## Наполнить БД тестовыми данными (заглушка — наполнится позже)
	@echo "seed: пока не реализовано (наполнится в фазе 2)"

test: ## Прогнать Go-тесты с детектором гонок
	go test -race ./...

lint: ## Статические проверки Go (golangci-lint добавится на шаге 5)
	go vet ./...
	@test -z "$$(gofmt -l .)" || { echo "gofmt: не отформатированы:"; gofmt -l .; exit 1; }
