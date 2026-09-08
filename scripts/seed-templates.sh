#!/usr/bin/env bash
# Заливка заготовок витрины шаблонов (фаза 19 POST-MVP).
#
# Шесть заготовок продукта живут в репозитории файлами (scripts/templates/*.json)
# и попадают на витрину ЕДИНСТВЕННЫМ путём — админской ручкой POST
# /api/v1/admin/templates. Второго пути нет намеренно: витрина обязана наполняться
# тем же кодом, что проверяет документ, иначе на неё однажды попал бы шаблон,
# который не открывается.
#
# Ручка сидит за сессией, поэтому скрипт логинится вашими данными. Пароль
# спрашивается без эха и никуда не сохраняется; аккаунт должен иметь
# users.is_admin = true (флаг ставится UPDATE-ом, интерфейса выдачи нет).
#
# ⚠ ПОВТОРНЫЙ ПРОГОН СОЗДАЁТ ДУБЛИКАТЫ: ручка заводит шаблон, а не обновляет
# одноимённый. Снять лишнее сегодня можно только SQL — снятия с публикации в
# продукте нет (осознанно не сделано, см. JOURNAL).
#
# Переменные: BASE_URL (по умолчанию http://localhost:8080), TRILLIX_EMAIL.
set -euo pipefail

base="${BASE_URL:-http://localhost:8080}"
dir="$(cd "$(dirname "$0")" && pwd)/templates"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT

command -v jq >/dev/null || { echo "нужен jq" >&2; exit 1; }

email="${TRILLIX_EMAIL:-}"
if [ -z "$email" ]; then read -rp "email администратора: " email; fi
# -s: пароль не печатается в терминал и не попадает ни в лог, ни в историю.
read -rsp "пароль: " password
echo

api() { curl -sS -b "$jar" -c "$jar" -H 'Content-Type: application/json' "$base/api/v1$1" "${@:2}"; }

# csrf — двойная отправка: значение читается из cookie и повторяется заголовком.
csrf() { awk '$6 == "csrf_token" { print $7 }' "$jar" | tail -1; }

echo "==> вход $email на $base"
login=$(api /auth/login -X POST --data-binary "$(jq -nc --arg e "$email" --arg p "$password" '{email:$e,password:$p}')")
if [ "$(jq -r '.twoFactorRequired // false' <<<"$login")" = true ]; then
	read -rp "код из письма: " code
	# Второй шаг CSRF не требует: сессии, от имени которой подделывают запрос,
	# ещё нет — право предъявляет подписанная cookie пропуска плюс код.
	login=$(api /auth/login-2fa -X POST --data-binary "$(jq -nc --arg c "$code" '{code:$c}')")
fi
if [ -z "$(jq -r '.id // empty' <<<"$login")" ]; then
	echo "вход не удался: $(jq -r '.error.code // .' <<<"$login")" >&2
	exit 1
fi

ok=0
for file in "$dir"/*.json; do
	name=$(basename "$file" .json)
	# 404 здесь означает «вы не администратор»: ручка не подтверждает своё
	# существование тому, у кого её нет (инвариант 5).
	body=$(api /admin/templates -X POST -H "X-CSRF-Token: $(csrf)" --data-binary "@$file")
	id=$(jq -r '.id // empty' <<<"$body")
	if [ -z "$id" ]; then
		echo "  ✗ $name — $(jq -rc '.error // .' <<<"$body")" >&2
		continue
	fi
	echo "  ✓ $name → $id"
	ok=$((ok + 1))
done

total=$(find "$dir" -name '*.json' | wc -l | tr -d ' ')
echo "==> залито $ok из $total"
[ "$ok" = "$total" ]
