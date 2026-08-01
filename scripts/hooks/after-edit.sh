#!/usr/bin/env bash
# PostToolUse (Write|Edit): форматирование Go и напоминание о второй стороне контракта.
#
# Контракт схемы формы живёт в двух местах — Go и Zod — и обязан меняться
# синхронно, в одном PR, с тестами обеих сторон. Расхождение не падает: оно
# компилируется и молча трактует новый тип как соседний. Это самый дорогой класс
# ошибок в проекте, поэтому напоминание приходит в момент правки, а не на ревью.
set -uo pipefail
cd "$(dirname "$0")/../.."

command -v jq >/dev/null || {
	echo "after-edit: jq не найден, напоминания о контракте не работают" >&2
	exit 2
}

payload=$(cat)
file=$(printf '%s' "$payload" | jq -r '.tool_response.filePath // .tool_input.file_path // empty')
[ -n "$file" ] || exit 0

case "$file" in
*.go) gofmt -w "$file" 2>/dev/null || true ;;
esac

# Нормализуем путь: ./internal/... не срезался вычитанием $PWD и не матчился case.
root=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
abs=$(realpath -m "$file" 2>/dev/null || echo "$file")
rel=${abs#"$root"/}
msg=""
case "$rel" in
internal/domain/schema.go)
	msg="Тронут Go-контракт схемы. Зеркальная сторона — web/shared/entities/formSchema.ts: правится в этом же PR, с тестами обеих сторон. Новый тип блока заводится в предикат (isChoice/isSingleChoice/isCaption/isContent), а не в цепочку if type == …"
	;;
web/shared/entities/formSchema.ts)
	msg="Тронут Zod-контракт схемы. Зеркальная сторона — internal/domain/schema.go и ValidateSchema: правятся в этом же PR, с тестами обеих сторон."
	;;
web/shared/fields/*)
	msg="Тронуты общие компоненты полей: их видят три поверхности (редактор, превью билдера, рендерер). Tailwind и shadcn сюда не тащить — сломают бюджет рендерера 45 КиБ. Проверь бюджет: cd web/renderer && npm run build && npm run check:bundle"
	;;
deploy/caddy/Caddyfile | deploy/compose.prod.yml)
	msg="Тронут прод-конфиг. Зелёный деплой не означает, что конфиг применился (TD-27): сверяй ЖИВОЙ конфиг через админ-API Caddy, а не факт успешного reload."
	;;
*) exit 0 ;;
esac

# additionalContext, а не systemMessage: напоминание адресовано модели (она правит
# вторую сторону контракта), а systemMessage харнесс показывает человеку.
jq -n --arg m "$msg" '{
  systemMessage: $m,
  hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}
}'
