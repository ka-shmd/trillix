#!/usr/bin/env bash
# Проверяемые машиной правила проекта: расхождения документов с кодом и те
# инварианты, которые выражаются структурно.
#
# Зачем: до июля 2026 расхождения доков с кодом *регистрировались* (TECH-DEBT §4),
# а не чинились, и реестр сам протух — TD-14 п.5 целую фазу описывал расхождение,
# которого уже не было. Правило проекта (PROCESS §3): проверка, которая не
# краснеет, хуже отсутствующей. Здесь живут те, что краснеть умеют.
#
# Каждая проверка обязана падать, если сломать то, что она сторожит (мутация).
# Добавляешь проверку — прогоняй мутацию и записывай её в комментарий рядом.
#
# Образец формата ошибки — «sqlc drift check» в .github/workflows/ci.yml.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
err() {
	echo "::error::$1"
	echo "   $2"
	fail=1
}
ok() { echo "  ✓ $1"; }

echo "Проверка документов и структурных инвариантов"
echo

# --- 1. Дерево модулей в ARCHITECTURE §4.2 ↔ ls internal/ --------------------
# Мутация: `mkdir internal/foo && touch internal/foo/x.go` → краснеет.
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
for m in migrations/*.up.sql; do
	num=$(basename "$m" | cut -d_ -f1)
	if ! grep -qE "(^|[^0-9])${num}([^0-9]|$)" docs/SCHEMA.md; then
		err "SCHEMA.md не упоминает миграцию $num" "файл: $m"
	fi
done
[ $fail -eq 0 ] && ok "все миграции ($(ls migrations/*.up.sql | wc -l)) упомянуты в SCHEMA.md"

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
documented=$(grep -hoP '^\s*(export\s+)?#?\s*\K[A-Z][A-Z0-9_]*(?=\s*=)' .env.example | sort -u)
# Грепаем по всему ./cmd и ./internal, а не по одному config.go: пакет config
# растёт файлами (s3.go, smtp.go), и проверка, смотрящая в один файл, молча
# пропускала бы новый. Заодно ловится нарушение «os.Getenv вне пакета config».
readvars=$(grep -rhoP 'os\.(Getenv|LookupEnv)\("\K[A-Z][A-Z0-9_]*(?=")' cmd internal | sort -u)
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

# --- 4. Ссылки на техдолг ---------------------------------------------------
# Ловит ровно ту гниль, что нашлась в TD-14: документ ссылается на пункт как на
# открытый, а он давно закрыт (или его вовсе нет).
# Мутация: сослаться на TD-999 из STATUS.md → краснеет.
# Номера берутся из ПОЗИЦИЙ ОБЪЯВЛЕНИЯ (`### TD-N` / `- **TD-N`), а не грепом по
# всему файлу: иначе номер, упомянутый в прозе чужого пункта, считается
# существующим, и удалённый TD молча проходит проверку.
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
[ $fail -eq 0 ] && ok "ссылки на техдолг ведут в существующие открытые пункты"

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

echo
if [ $fail -ne 0 ]; then
	echo "Проверка документов НЕ пройдена — почини расхождение и повтори."
	exit 1
fi
echo "Документы и структурные инварианты сходятся с кодом."
