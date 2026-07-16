#!/usr/bin/env bash
# make dev-all — весь dev-контур одной командой: Postgres + API + кабинет + рендерер.
# Ctrl-C (или закрытие терминала) гасит API и оба фронта. Postgres остаётся поднятым
# (данные в volume; погасить БД — make db-down). Запускать через `make dev-all`:
# make грузит .env в окружение, откуда API берёт конфигурацию.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose --env-file .env -f compose.dev.yml"

echo "dev-all: поднимаю Postgres и MinIO, жду готовности…"
$COMPOSE up -d --wait postgres minio
# createbuckets — одноразовый бутстрап бакета (отрабатывает и выходит с 0). Из
# --wait его исключаем: завершившийся контейнер там считается провалом. Запускаем
# отдельно без ожидания (свою готовность он обеспечивает сам — ждёт MinIO в цикле).
$COMPOSE up -d createbuckets

echo "dev-all: применяю миграции…"
go run ./cmd/api migrate up

# API запускаем собранным бинарём, а не `go run`: так сигнал остановки бьёт по
# самому серверу (обёртка go run не всегда пробрасывает его дочернему процессу).
echo "dev-all: собираю API…"
go build -o ./api ./cmd/api

pids=()
cleanup() {
  trap - INT TERM EXIT
  echo ""
  echo "dev-all: останавливаю API и фронты…"
  kill "${pids[@]}" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "dev-all: остановлено (Postgres ещё работает — make db-down, чтобы погасить)."
}
trap cleanup INT TERM EXIT

# exec в подоболочке: фоновый процесс становится самим npm, поэтому kill по его pid
# гасит vite напрямую, не оставляя сироту.
./api &
pids+=("$!")
(
  cd web/app && exec npm run dev
) &
pids+=("$!")
(
  cd web/renderer && exec npm run dev
) &
pids+=("$!")

echo ""
echo "dev-all готов:"
echo "  API      → http://localhost:8080"
echo "  кабинет  → http://localhost:5173"
echo "  рендерер → http://localhost:5174/r/{slug}"
echo "Ctrl-C — остановить API и фронты."
wait
