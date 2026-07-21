#!/usr/bin/env bash
# Обновление прод-сервера до релиза $TAG. Запускается НЕ локально, а на сервере —
# релизный workflow (deploy job) прокидывает этот скрипт по SSH:
#   ssh deploy@host "TAG='vX.Y.Z' bash -s" < deploy/remote-update.sh
#
# Сервер сам тянет всё готовое (образ из GHCR, статику из Release) своими
# кредами (PAT в gh + docker login) — CI только запускает обновление. Идемпотентно:
# повторный прогон того же тега безопасен.
set -euo pipefail

: "${TAG:?TAG не задан (ожидается из окружения)}"
cd /opt/trillix

echo "== git → $TAG =="
git fetch --tags --force origin
git checkout -f "$TAG"

echo "== статика из релиза $TAG =="
gh release download "$TAG" --repo ka-shmd/trillix --pattern 'trillix-static-*.tar.gz' --dir /tmp --clobber
rm -rf deploy/static/app deploy/static/renderer
mkdir -p deploy/static
tar -xzf "/tmp/trillix-static-$TAG.tar.gz" -C deploy/static

echo "== TAG в .env → $TAG =="
sed -i "s|^TAG=.*|TAG=$TAG|" .env

echo "== образ + перезапуск =="
docker compose --env-file .env -f deploy/compose.prod.yml pull
docker compose --env-file .env -f deploy/compose.prod.yml up -d --remove-orphans

# Caddyfile примонтирован в контейнер bind-mount'ом, а определение сервиса caddy при
# правке файла не меняется — значит `up -d` контейнер НЕ пересоздаёт, и новый конфиг
# так и остался бы лежать на диске, не применившись. Без этой строки любая правка
# Caddyfile (заголовки, маршруты, lb_try_duration) молча не доезжала бы до прода.
# `caddy reload` перечитывает конфиг на живую, без разрыва соединений.
echo "== перечитать конфиг Caddy =="
docker compose --env-file .env -f deploy/compose.prod.yml exec -T caddy \
  caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

docker image prune -f

echo "== деплой $TAG завершён =="
