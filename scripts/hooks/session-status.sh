#!/usr/bin/env bash
# SessionStart: впрыснуть docs/STATUS.md в контекст сессии.
#
# Зачем хуком, а не правилом «прочитай STATUS.md»: правило исполняет модель и
# может его не выполнить или выполнить частично, а какой из двух случаев
# произошёл — непроверяемо. Хук исполняет харнесс. Одна страница — дешевле, чем
# 85 000 токенов обязательного чтения, которые были раньше.
set -uo pipefail
cd "$(dirname "$0")/../.."

command -v jq >/dev/null || {
	echo "session-status: jq не найден, STATUS.md не впрыснут" >&2
	exit 2
}

[ -f docs/STATUS.md ] || exit 0

jq -Rs --arg hdr "Актуальное состояние проекта (docs/STATUS.md, впрыснуто автоматически):" \
	'{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: ($hdr + "\n\n" + .)}}' \
	<docs/STATUS.md
