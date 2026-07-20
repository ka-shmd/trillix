#!/usr/bin/env bash
# Тонкий смоук prod-local (Фаза 7, шаг 5): проверяет, что стек поднялся и
# отвечает по https, плюс единственную вещь, которой не было в dev — Secure-cookie
# и CSRF в настоящей схеме за Caddy. Полный функциональный прогон (форма от и до) —
# это e2e шага 7, не здесь.
#
# Аргумент: имя compose-проекта (для имени docker-сети). По умолчанию — trillix-prod-local.
set -euo pipefail

project="${1:-trillix-prod-local}"
net="${project}_default"
APP=app.localhost
REND=f.localhost

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

# curl через Caddy: --resolve — не зависеть от резолвинга *.localhost; -k — не
# зависеть от доверия к внутреннему CA Caddy (для смоука сертификат не проверяем).
capp()  { curl -sk --resolve "$APP:443:127.0.0.1"  "https://$APP$1"  "${@:2}"; }
crend() { curl -sk --resolve "$REND:443:127.0.0.1" "https://$REND$1" "${@:2}"; }

echo "==> ждём готовности стека (app.localhost отвечает)..."
for _ in $(seq 1 30); do
	[ "$(capp / -o /dev/null -w '%{http_code}' || true)" = 200 ] && break
	sleep 1
done

echo "==> 1) /healthz по внутренней compose-сети ($net)"
hz=$(docker run --rm --network "$net" curlimages/curl:latest -s http://api:8080/healthz || true)
echo "$hz" | grep -q '"status":"ok"' || fail "healthz вернул: $hz"
echo "    ok"

echo "==> 2) app.localhost/ (статика кабинета)"
code=$(capp / -o /dev/null -w '%{http_code}'); [ "$code" = 200 ] || fail "app / = $code"
echo "    200"

echo "==> 3) f.localhost/ (статика рендерера)"
code=$(crend / -o /dev/null -w '%{http_code}'); [ "$code" = 200 ] || fail "renderer / = $code"
echo "    200"

echo "==> 4) f.localhost/r/<несуществующий> → 404 (путь Caddy→Go→Postgres)"
code=$(crend "/r/nope-$(date +%s)" -o /dev/null -w '%{http_code}')
[ "$code" = 404 ] || fail "несуществующая форма = $code (ожидалось 404)"
echo "    404"

echo "==> 5) cookie Secure + CSRF по https"
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT
email="smoke-$(date +%s)@example.com"
hdrs=$(capp /api/v1/auth/register -D - -o /dev/null -c "$jar" \
	-H 'Content-Type: application/json' \
	--data "{\"email\":\"$email\",\"password\":\"supersecret123\"}")
echo "$hdrs" | grep -i '^set-cookie:.*session' | grep -qi 'Secure' \
	|| fail "session cookie без флага Secure:"$'\n'"$hdrs"
echo "    session cookie: Secure ✓"
# Мутация с валидной сессией, но без X-CSRF-Token → 403 (CSRF-защита активна).
code=$(capp /api/v1/forms -b "$jar" -X POST -H 'Content-Type: application/json' \
	--data '{"title":"smoke"}' -o /dev/null -w '%{http_code}')
[ "$code" = 403 ] || fail "POST /forms без CSRF-токена = $code (ожидалось 403)"
echo "    CSRF без токена → 403 ✓"

echo
echo "SMOKE OK — prod-local жив (https, cookie Secure, CSRF)."
