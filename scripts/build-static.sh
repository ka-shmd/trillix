#!/usr/bin/env bash
# Прод-сборка обоих фронтов и раскладка статики в каталог, который Caddy монтирует
# как /srv/static (deploy/compose.prod.yml: ./static:/srv/static). Вызывается из
# `make prod-local` (фаза 7, шаг 5); можно и напрямую.
#
# Различия контуров приходят через env (Makefile экспортирует их из .env):
#   VITE_PUBLIC_BASE_URL — база рендерера, зашивается в бандл кабинета (ссылка на
#                          опубликованную форму). Обязательна для прод-сборки.
# API кабинета и публичный API зовутся относительными путями (/api, /public) —
# same-origin, отдельной VITE-переменной для базы API нет (ADR §10).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
static="$root/deploy/static"

if [ -z "${VITE_PUBLIC_BASE_URL:-}" ]; then
	echo "build-static: VITE_PUBLIC_BASE_URL не задан (нужен для ссылки на форму в кабинете)" >&2
	echo "  задайте его в .env прод-контура, напр. VITE_PUBLIC_BASE_URL=https://f.localhost" >&2
	exit 1
fi

build() {
	local dir="$1"
	echo "==> сборка $dir (npm ci && npm run build)"
	# npm ci — воспроизводимая установка ровно по lock-файлу (прод-сборка, не dev).
	npm --prefix "$root/web/$dir" ci
	npm --prefix "$root/web/$dir" run build
}

build app
build renderer

# Бюджет бандла рендерера — тот же порог, что в CI; overflow валит и локальную сборку.
echo "==> проверка бюджета бандла рендерера"
npm --prefix "$root/web/renderer" run check:bundle

echo "==> раскладка статики в $static"
# Каталог $static Caddy держит как bind-mount (compose.prod.yml). Удалять его
# целиком нельзя — rm+пересоздание меняет inode и рвёт mount в уже запущенном
# caddy (тот начинает видеть пустоту). Поэтому сохраняем корень, заменяем лишь
# содержимое app/ и renderer/.
mkdir -p "$static"
rm -rf "$static/app" "$static/renderer"
cp -r "$root/web/app/dist" "$static/app"
cp -r "$root/web/renderer/dist" "$static/renderer"

echo "build-static: готово — $static/{app,renderer}"
