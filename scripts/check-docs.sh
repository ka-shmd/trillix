#!/usr/bin/env bash
# Проверяемые машиной правила проекта: расхождения документов с кодом и те
# инварианты, которые выражаются структурно.
#
# Зачем: до июля 2026 расхождения доков с кодом *регистрировались* (TECH-DEBT §4),
# а не чинились, и реестр сам протух — TD-14 п.5 целую фазу описывал расхождение,
# которого уже не было. Правило проекта (PROCESS §4): проверка, которая не
# краснеет, хуже отсутствующей. Здесь живут те, что краснеть умеют.
#
# Каждая проверка обязана падать, если сломать то, что она сторожит (мутация).
# Добавляешь проверку — прогоняй мутацию и записывай её в комментарий рядом.
#
# Образец формата ошибки — «sqlc drift check» в .github/workflows/ci.yml.
set -uo pipefail
cd "$(dirname "$0")/.."

# fail — итог всего прогона (код возврата), errs — счётчик ТЕКУЩЕЙ проверки.
# Раздельно, потому что «✓» обязана означать «эта проверка прошла», а не «пока
# никто не падал»: на общем счётчике падение первой проверки гасило галочки всех
# следующих, и вывод выглядел так, будто они не отработали.
fail=0
errs=0
err() {
	echo "::error::$1"
	echo "   $2"
	fail=1
	errs=$((errs + 1))
}
ok() { echo "  ✓ $1"; }
# Сбросить счётчик перед очередной проверкой.
begin() { errs=0; }
# Напечатать «✓», только если эта проверка не дала ошибок.
ok_if_clean() { [ $errs -eq 0 ] && ok "$1"; }

echo "Проверка документов и структурных инвариантов"
echo

# --- 1. Дерево модулей в ARCHITECTURE §4.2 ↔ ls internal/ --------------------
# Мутация: `mkdir internal/foo && touch internal/foo/x.go` → краснеет.
begin
real=$(find internal -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
# Только ветка internal/: у cmd/ и web/ в дереве та же глубина отступа, поэтому
# без вырезания секции сюда попадали api, app и renderer. Диапазоном sed, а не
# смещениями awk: рамка дерева — многобайтовая, substr считает байты и промахивается.
doc=$(sed -n '/^├── internal\//,/^├── migrations\//p' docs/ARCHITECTURE.md |
	grep -oP '^│\s+[├└]── \K[a-z][a-z0-9_]*(?=/)' | sort -u)
missing=$(comm -23 <(echo "$real") <(echo "$doc") | tr '\n' ' ' | xargs)
extra=$(comm -13 <(echo "$real") <(echo "$doc") | tr '\n' ' ' | xargs)
if [ -n "$missing" ] || [ -n "$extra" ]; then
	err "ARCHITECTURE.md §4.2: дерево модулей разошлось с internal/" \
		"нет в документе: ${missing:-—} | нет в коде: ${extra:-—}"
else
	ok "дерево модулей ARCHITECTURE §4.2 = internal/ ($(echo "$real" | wc -l) шт.)"
fi

# --- 2. Миграции ↔ SCHEMA.md -------------------------------------------------
# Мутация: завести миграцию 0009 без правки SCHEMA.md → краснеет.
begin
for m in migrations/*.up.sql; do
	num=$(basename "$m" | cut -d_ -f1)
	if ! grep -qE "(^|[^0-9])${num}([^0-9]|$)" docs/SCHEMA.md; then
		err "SCHEMA.md не упоминает миграцию $num" "файл: $m"
	fi
done
ok_if_clean "все миграции ($(ls migrations/*.up.sql | wc -l)) упомянуты в SCHEMA.md"

# --- 2б. Типы блоков ↔ сводная таблица в fields/README.md --------------------
# Мутация: добавить тип в BLOCK_TYPES без строки в таблице (или убрать строку) →
# краснеет. Таблица — карта для чтения, и устаревшая карта хуже отсутствующей:
# «как добавить тип» — единственный документ, куда идут именно за полнотой списка.
begin
readme=web/shared/fields/README.md
listed=$(grep -oE '^\| `[a-z_]+` \|' "$readme" | grep -oE '[a-z_]+' | sort -u)
declared=$(sed -n '/^export const BLOCK_TYPES = \[/,/\] as const/p' \
	web/shared/entities/blocks/contract.ts |
	grep -vE '^\s*//' | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u)
for t in $declared; do
	echo "$listed" | grep -qx "$t" || err "тип $t объявлен в BLOCK_TYPES, но его нет в сводной таблице" "файл: $readme"
done
for t in $listed; do
	echo "$declared" | grep -qx "$t" || err "тип $t есть в сводной таблице, но его нет в BLOCK_TYPES" "файл: $readme"
done
ok_if_clean "все типы блоков ($(echo "$declared" | wc -w)) есть в сводной таблице fields/README.md"

# --- 3. env-переменные: всё читаемое и задаваемое задокументировано ----------
# Пункт Definition of Done «новые env-переменные в четырёх местах» до сих пор
# держался только галочкой в чек-листе.
#
# Проверяем в сторону «.env.example — полная документация», а не наоборот:
# обратное направление даёт ложные срабатывания на переменных, которые нужны
# только прод-контуру (домены Caddy, HSTS_MAX_AGE, MEDIA_UPSTREAM) и в dev
# осмысленно отсутствуют. А вот необъявленная переменная — всегда дефект:
# приложение читает то, чего никто не описал.
#
# Мутация: добавить os.Getenv("FOO") в internal/config → краснеет;
#          добавить FOO= в .env.dev → краснеет.
begin
documented=$(grep -hoP '^\s*(export\s+)?#?\s*\K[A-Z][A-Z0-9_]*(?=\s*=)' .env.example | sort -u)
# Грепаем по всему ./cmd и ./internal, а не по одному config.go: пакет config
# растёт файлами (s3.go, smtp.go), и проверка, смотрящая в один файл, молча
# пропускала бы новый. Заодно ловится нарушение «os.Getenv вне пакета config».
#
# Два прохода, потому что переменные читаются НЕ через os.Getenv: в этом проекте
# есть хелпер `required("HTTP_ADDR")`, и регулярка по одному os.Getenv видела
# 1 имя из 15 — проверка была почти декоративной.
#
#   в internal/config — любой вызов f("ИМЯ"): хелперов может стать больше;
#   вне config       — только os.Getenv/LookupEnv (он там и так запрещён).
#
# Скоуп по каталогу, а не широкий шаблон по всему коду: последний ловил "IHDR"
# из PNG-декодера (internal/media) и требовал внести чанк формата в .env.example.
#
# Мутация: добавить required("FOO") в internal/config → краснеет;
#          добавить os.Getenv("FOO") в cmd/api → краснеет;
#          добавить FOO= в .env.dev → краснеет.
readvars=$( {
	grep -rhoP '\b[a-zA-Z_]+\("\K[A-Z][A-Z0-9_]{2,}(?="\))' internal/config --include='*.go'
	grep -rhoP 'os\.(Getenv|LookupEnv)\("\K[A-Z][A-Z0-9_]{2,}(?=")' cmd internal --include='*.go'
} | sort -u)
for v in $readvars; do
	echo "$documented" | grep -qx "$v" ||
		err "код читает $v, но .env.example его не описывает" \
			"DoD: config + .env.example + оба контура — в одном коммите"
done
for f in .env.dev .env.prod-local; do
	# Пропавший файл — дефект, а не «в нём нет лишних переменных»: без явной
	# ветки переименование контура делало бы проверку декоративной при зелёном выводе.
	[ -f "$f" ] || {
		err "нет файла $f" "проверка env-переменных контура не выполнена"
		continue
	}
	for v in $(grep -hoP '^\s*(export\s+)?\K[A-Z][A-Z0-9_]*(?=\s*=)' "$f" | sort -u); do
		echo "$documented" | grep -qx "$v" ||
			err "$f задаёт $v, но .env.example его не описывает" \
				"каждая переменная контура обязана быть задокументирована"
	done
done
ok_if_clean "env-переменные описаны в .env.example ($(echo "$readvars" | wc -w) читаемых кодом)"

# --- 3b. env-переменные доезжают до контейнера ------------------------------
# Проверка 3 сторожит документацию, но не доставку: якорь x-app-env в
# compose.prod.yml перечисляет переменные ПОИМЁННО (сознательно — чтобы не
# подхватить чужой env_file), и переменная, забытая там, не попадёт в процесс,
# сколько её ни клади в серверный .env.
#
# Ровно так фаза 11 уехала на прод молча сломанной: workflow зелёный, ключи на
# сервере лежат, а /auth/providers отдаёт пустой список. Ни одна из пяти
# проверок этого не видела — они смотрели на документы, а не на доставку.
#
# Направление одно: всё, что читает код, обязано быть в якоре. Обратное
# направление не проверяем — в якоре законно живут переменные, которые читает
# сам compose, а не приложение.
#
# Мутация (прогнана): убрать YANDEX_OAUTH_CLIENT_ID из x-app-env → краснеет
# ровно тем сообщением, которого не хватило при выкатке v0.11.0.
begin
compose=deploy/compose.prod.yml
if [ ! -f "$compose" ]; then
	err "нет файла $compose" "проверка доставки env-переменных не выполнена"
else
	# Якорь читается от 'x-app-env:' до первой строки, начинающейся не с пробела
	# (следующий ключ верхнего уровня).
	delivered=$(sed -n '/^x-app-env:/,/^[^[:space:]]/p' "$compose" |
		grep -oP '^\s+\K[A-Z][A-Z0-9_]*(?=:)' | sort -u)
	for v in $readvars; do
		echo "$delivered" | grep -qx "$v" ||
			err "код читает $v, но x-app-env в compose.prod.yml её не передаёт" \
				"переменная не доедет до контейнера ни при каком .env"
	done
fi
ok_if_clean "все читаемые кодом переменные передаются в контейнер (x-app-env)"

# --- 4. Ссылки на техдолг ---------------------------------------------------
# Ловит ровно ту гниль, что нашлась в TD-14: документ ссылается на пункт как на
# открытый, а он давно закрыт (или его вовсе нет).
# Мутация: сослаться на TD-999 из STATUS.md → краснеет.
# Номера берутся из ПОЗИЦИЙ ОБЪЯВЛЕНИЯ (`### TD-N` / `- **TD-N`), а не грепом по
# всему файлу: иначе номер, упомянутый в прозе чужого пункта, считается
# существующим, и удалённый TD молча проходит проверку.
begin
grep -q '^## Закрыто' docs/TECH-DEBT.md ||
	err "в TECH-DEBT.md нет раздела «## Закрыто»" \
		"проверка закрытых пунктов не может выполниться — это дефект скрипта, а не факт о мире"
closed=$(awk '/^## Закрыто/,0' docs/TECH-DEBT.md | grep -oP '^-\s+\*\*TD-\K[0-9]+' | sort -un)
known=$(grep -oP '^(###\s+|-\s+\*\*)TD-\K[0-9]+' docs/TECH-DEBT.md | sort -un)
for f in docs/STATUS.md docs/DEV-PLAN.md README.md; do
	[ -f "$f" ] || continue
	for td in $(grep -oP '\bTD-\K[0-9]+' "$f" | sort -un); do
		if ! echo "$known" | grep -qx "$td"; then
			err "$f ссылается на TD-$td, которого нет в TECH-DEBT.md" "опечатка или пункт удалён"
		elif [ "$f" = "docs/STATUS.md" ] && echo "$closed" | grep -qx "$td"; then
			err "STATUS.md показывает TD-$td как открытый, а он в разделе «Закрыто»" \
				"состояние обязано быть правдой — почини строку, а не заводи заметку"
		fi
	done
done
ok_if_clean "ссылки на техдолг ведут в существующие открытые пункты"

# --- 5. Инвариант 4: пользовательский контент рендерится как текст -----------
# Дубль eslint-правила: eslint из web/app и web/renderer не видит web/shared,
# а инвариант заявлен «во всём репозитории».
# Мутация: вписать dangerouslySetInnerHTML в любой .tsx → краснеет.
# Комментарии исключаются: в ThankYou.tsx упоминание живёт в пояснении «текст
# владельца рендерится как текст», и запрещать разговор о запрете — абсурд.
# Паттерны шире, чем кажется нужным, потому что дыры здесь молчаливые:
# `+=` не матчился простым `=`, доступ по строковому ключу и insertAdjacentHTML
# обходили проверку вовсе, а `--include` без .js пропускал целый класс файлов.
# Артефакты сборки исключены: в собранном React innerHTML есть штатно, и без
# --exclude-dir проверка краснела бы от чужого кода после каждого `npm run build`.
begin
hits=$(grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
	--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build \
	--exclude-dir=coverage --exclude='eslint.config.js' \
	-e 'dangerouslySetInnerHTML' \
	-e '\.\(inner\|outer\)HTML\s*[+|&^]\?=' \
	-e '\["\(inner\|outer\)HTML"\]' \
	-e "\\['\\(inner\\|outer\\)HTML'\\]" \
	-e 'insertAdjacentHTML' \
	web 2>/dev/null |
	grep -vP ':\s*\d+:\s*(//|\*|/\*)' || true)
if [ -n "$hits" ]; then
	err "Инвариант 4 нарушен: пользовательский контент обязан рендериться как текст" "$hits"
else
	ok "инвариант 4: ни одного dangerouslySetInnerHTML/innerHTML в web/"
fi

# --- 6. Единая точка лимитов тарифа -----------------------------------------
# `if plan == "free"` вне internal/entitlements запрещён (internal/CLAUDE.md,
# ADR §10). Причина не в красоте: рассыпанные по коду проверки означают, что
# через полгода на вопрос «что входит в Pro» отвечает только греп, а страница
# тарифов начинает врать в сторону, которую никто не заметит до жалобы.
# Мутация: вписать `if plan == "free"` в любой сервис → краснеет.
# Ищем сравнение с кодом плана в любую сторону; сам пакет entitlements и тесты
# исключены — там сравнение с планом законно (это и есть точка решения).
begin
hits=$(grep -rn --include='*.go' \
	--exclude-dir=entitlements --exclude='*_test.go' \
	-E '(plan|planCode|PlanCode|plan_code)\s*[!=]=\s*"(free|pro|legacy_free)"|"(free|pro|legacy_free)"\s*[!=]=\s*(plan|planCode|PlanCode)' \
	cmd internal 2>/dev/null || true)
if [ -n "$hits" ]; then
	err "Проверка плана мимо internal/entitlements: единая точка лимитов обходится" "$hits"
else
	ok "нет сравнений с кодом плана вне internal/entitlements"
fi

echo
if [ $fail -ne 0 ]; then
	echo "Проверка документов НЕ пройдена — почини расхождение и повтори."
	exit 1
fi
echo "Документы и структурные инварианты сходятся с кодом."
