#!/usr/bin/env bash
# Бэкап прод-БД (Фаза 10, шаг 1). Запускается системным cron НА СЕРВЕРЕ каждые 6 часов:
#   0 */6 * * *  cd /opt/trillix && ./deploy/backup.sh >> /var/log/trillix-backup.log 2>&1
# (установка cron и секретов — deploy/README.md, раздел «Бэкапы»).
#
# Что делает: снимает консистентный дамп Postgres (pg_dump -Fc из контейнера),
# шифрует его age на ПУБЛИЧНЫЙ ключ (BACKUP_AGE_RECIPIENT) и заливает в S3-бакет
# ДРУГОГО провайдера (Yandex Object Storage), чем медиа на reg.ru Cloud — чтобы отказ
# или компрометация одного провайдера не унесли сразу и данные, и бэкапы.
#
# Приватный ключ age на сервере НЕ хранится: сервер умеет только шифровать. Расшифровать
# бэкап можно лишь identity-файлом, который лежит офлайн у владельца (deploy/RESTORE.md).
# Иначе кто владеет сервером — владеет и ключом, и офсайт-шифрование бессмысленно.
#
# Ротация: суточный слой (`daily/`, каждый прогон) хранится 14 суток; недельный
# (`weekly/`, снимок по понедельникам) — 8 недель. Идемпотентно, повторный прогон безопасен.
#
# Зависимости на сервере (ставятся вручную при провижининге, см. deploy/README.md):
#   age (шифрование), awscli (S3-совместимая заливка). Postgres-инструменты берутся
#   из контейнера postgres, локально их иметь не нужно.
set -euo pipefail

cd "$(dirname "$0")/.."   # корень репозитория на сервере — /opt/trillix

# --- Конфиг из того же .env, что у compose --------------------------------------
# Забираем POSTGRES_* (для pg_dump в контейнере) и BACKUP_* (куда и чем шифровать).
# Значения не печатаем: секреты в лог не попадают (инвариант 7).
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${POSTGRES_USER:?POSTGRES_USER не задан в .env}"
: "${POSTGRES_DB:?POSTGRES_DB не задан в .env}"
: "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT не задан в .env}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET не задан в .env}"
: "${BACKUP_S3_ACCESS_KEY:?BACKUP_S3_ACCESS_KEY не задан в .env}"
: "${BACKUP_S3_SECRET_KEY:?BACKUP_S3_SECRET_KEY не задан в .env}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT не задан в .env}"
: "${BACKUP_S3_REGION:=ru-central1}"   # регион Yandex Object Storage по умолчанию

# Креды S3 отдаём awscli через окружение, а не флагами (флаги видны в ps).
export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY"
export AWS_DEFAULT_REGION="$BACKUP_S3_REGION"

COMPOSE=(docker compose --env-file .env -f deploy/compose.prod.yml)
aws_s3() { aws --endpoint-url "$BACKUP_S3_ENDPOINT" "$@"; }
log()    { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# --- Блокировка от наложения прогонов -------------------------------------------
# Свой лок (не деплойный): два бэкапа подряд не должны наложиться, если один
# затянулся. С деплоем бэкап не конфликтует — pg_dump снимает консистентный снимок
# независимо от того, перезапускается ли рядом api.
exec 8>/tmp/trillix-backup.lock
if ! flock -n 8; then
	log "другой бэкап ещё идёт — пропускаем этот прогон"
	exit 0
fi

# --- Снятие и шифрование дампа ---------------------------------------------------
# В temp-файл, а не потоком сразу в S3: при обрыве pg_dump залить недодамп нельзя.
# pipefail ловит падение pg_dump в конвейере до age.
stamp="$(date -u +%Y-%m-%d-%H%M)"
name="trillix-${stamp}.sql.age"
tmp="$(mktemp /tmp/trillix-backup.XXXXXX.age)"
trap 'rm -f "$tmp"' EXIT

log "снимаю дамп $POSTGRES_DB → шифрую age → $name"
"${COMPOSE[@]}" exec -T postgres \
	pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB" </dev/null |
	age -r "$BACKUP_AGE_RECIPIENT" -o "$tmp"

size="$(wc -c <"$tmp" | tr -d ' ')"
if [ "$size" -lt 1024 ]; then
	log "ОШИБКА: зашифрованный дамп подозрительно мал ($size байт) — не заливаю"
	exit 1
fi
log "дамп готов: $size байт"

# --- Заливка суточного слоя ------------------------------------------------------
aws_s3 s3 cp "$tmp" "s3://${BACKUP_S3_BUCKET}/daily/${name}" --only-show-errors
log "залит s3://${BACKUP_S3_BUCKET}/daily/${name}"

# --- Недельный снимок: первый понедельничный прогон копирует суточный в weekly/ ---
# Копией на стороне S3, без повторного шифрования. Идемпотентно: 2–4 понедельничных
# прогона не плодят дубли (ключ фиксирован на ISO-неделю, проверяем наличие).
if [ "$(date -u +%u)" = "1" ]; then
	# Полная дата понедельника в ключе (не только номер недели): без ГГГГ-ММ-ДД
	# дата-ротация ниже не смогла бы состарить недельный слой. Все прогоны одного
	# понедельника дают один и тот же ключ → проверка наличия делает копирование идемпотентным.
	wname="trillix-$(date -u +%Y-%m-%d)-W$(date -u +%V).sql.age"
	wkey="s3://${BACKUP_S3_BUCKET}/weekly/${wname}"
	if aws_s3 s3 ls "$wkey" >/dev/null 2>&1; then
		log "недельный снимок $wname уже есть — пропускаю"
	else
		aws_s3 s3 cp "s3://${BACKUP_S3_BUCKET}/daily/${name}" "$wkey" --only-show-errors
		log "залит недельный снимок $wkey"
	fi
fi

# --- Ротация ---------------------------------------------------------------------
# По дате, вшитой в ключ (устойчиво к смене таймзоны сервера и к порядку в листинге).
# Ошибка чистки не роняет бэкап: свежий дамп уже залит — это важнее удаления старых.
prune() {
	local prefix="$1" keep_days="$2" cutoff key d ts
	cutoff="$(date -u -d "${keep_days} days ago" +%s)"
	aws_s3 s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" --prefix "$prefix" \
		--query 'Contents[].Key' --output text 2>/dev/null |
		tr '\t' '\n' | while read -r key; do
		[ -n "$key" ] || continue
		d="$(echo "$key" | grep -oP '\d{4}-\d{2}-\d{2}' | head -1)" || continue
		[ -n "$d" ] || continue
		ts="$(date -u -d "$d" +%s 2>/dev/null || echo 0)"
		if [ "$ts" -gt 0 ] && [ "$ts" -lt "$cutoff" ]; then
			aws_s3 s3 rm "s3://${BACKUP_S3_BUCKET}/${key}" --only-show-errors && log "ротация: удалён $key"
		fi
	done
}
prune "daily/"  14 || log "предупреждение: ротация daily/ не завершилась"
prune "weekly/" 56 || log "предупреждение: ротация weekly/ не завершилась"

log "бэкап завершён"
