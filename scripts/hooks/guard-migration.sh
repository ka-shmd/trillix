#!/usr/bin/env bash
# PreToolUse (Write|Edit): не дать отредактировать уже смерженную миграцию.
#
# Правило migrations/CLAUDE.md: «уже смерженная миграция никогда не редактируется —
# только новая поверх». Оно абсолютное и с необратимыми последствиями (прод-схема
# расходится с миграциями молча), но жило одной строкой в самом редко читаемом
# файле проекта. Хук исполняет харнесс — забыть правило больше нельзя.
#
# Новая миграция, заведённая в текущей ветке, коммитов на main не имеет и
# правится свободно.
set -uo pipefail
cd "$(dirname "$0")/../.."

payload=$(cat)
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')

case "$file" in
*/migrations/*.sql | migrations/*.sql) ;;
*) exit 0 ;;
esac

rel=${file#"$PWD"/}
# Пусто = миграция ещё не на main, значит своя и правится.
git log --oneline origin/main -- "$rel" 2>/dev/null | grep -q . ||
	git log --oneline main -- "$rel" 2>/dev/null | grep -q . || exit 0

jq -n --arg f "$rel" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("Миграция \($f) уже смержена в main — редактировать её запрещено (migrations/CLAUDE.md). Изменение схемы оформляется НОВОЙ миграцией поверх, обратно совместимой с работающим кодом предыдущей версии: добавить колонку/таблицу/индекс можно, переименовать или удалить — только в два релиза.")
  }
}'
