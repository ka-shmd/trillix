#!/usr/bin/env bash
# Фаза 9, шаг 6: доказать, что выкатка не роняет пользователя в 502.
#
# Долбит публичный путь, проходящий насквозь Caddy → Go → Postgres, и считает
# статусы. Пробу шлём на заведомо несуществующую форму: ожидаемый ответ 404 —
# он доказывает, что цепочка жива целиком (Caddy дошёл до Go, Go сходил в базу).
# 200 бы не доказывал: его отдала бы и одна статика Caddy при мёртвом api.
#
# Любой 5xx — провал: это ровно то окно, когда старый контейнер уже остановлен,
# а новый ещё не принимает.
#
# Запускать ПАРАЛЛЕЛЬНО с выкаткой:
#   терминал A:  scripts/deploy-no-502.sh                 # проба
#   терминал B:  git push origin vX.Y.Z                   # или на сервере:
#                docker compose --env-file .env -f deploy/compose.prod.yml up -d --force-recreate api
#
# Использование: scripts/deploy-no-502.sh [URL] [СЕКУНД]
set -uo pipefail

URL="${1:-https://f.trillix.ru/r/deploy-probe-nonexistent}"
DURATION="${2:-60}"
INTERVAL="${INTERVAL:-0.2}"
# INSECURE=1 — для прогона против prod-local: там TLS от локального CA Caddy,
# которому curl не доверяет без разового `make prod-local-trust`.
CURL_TLS=""
[ "${INSECURE:-0}" = "1" ] && CURL_TLS="-k"

ok=0        # 404 — цепочка жива (ожидаемый ответ пробы)
bad5xx=0    # 502/503/504 — провал шага
other=0     # прочее (редиректы, 200, 4xx кроме 404)
total=0
first_bad=""
last_bad=""
declare -A seen

printf '==> проба %s каждые %s с в течение %s с\n' "$URL" "$INTERVAL" "$DURATION"
printf '    ожидаем 404 на каждый запрос; любой 5xx — провал\n\n'

end=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$end" ]; do
	code=$(curl -s $CURL_TLS -o /dev/null -w '%{http_code}' --max-time 10 "$URL" 2>/dev/null || echo "000")
	total=$(( total + 1 ))
	seen[$code]=$(( ${seen[$code]:-0} + 1 ))

	case "$code" in
		404) ok=$(( ok + 1 )) ;;
		5*|000)
			bad5xx=$(( bad5xx + 1 ))
			now=$(date '+%H:%M:%S')
			[ -z "$first_bad" ] && first_bad="$now"
			last_bad="$now"
			printf '    [%s] %s <-- ПРОВАЛ\n' "$now" "$code"
			;;
		*) other=$(( other + 1 )) ;;
	esac
	sleep "$INTERVAL"
done

printf '\n==> итог за %s с (%s запросов)\n' "$DURATION" "$total"
for code in "${!seen[@]}"; do
	printf '    %s : %s\n' "$code" "${seen[$code]}"
done

if [ "$bad5xx" -gt 0 ]; then
	printf '\nПРОВАЛ: %s ответов 5xx/обрывов (с %s по %s).\n' "$bad5xx" "$first_bad" "$last_bad"
	printf 'Пользователь в это окно видел ошибку. Лечится удержанием запроса в Caddy\n'
	printf '(lb_try_duration), а не правкой Go: graceful shutdown спасает запросы\n'
	printf 'в полёте, но не щель между остановкой старого и готовностью нового.\n'
	exit 1
fi

printf '\nOK: 5xx не было — выкатка прошла незаметно для пользователя (%s ответов 404).\n' "$ok"
