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

# Блокировка на весь деплой. CI сериализует свои прогоны (job-level concurrency
# `deploy-prod`), но это не защищает от ручного запуска скрипта параллельно с
# автодеплоем: два `git checkout` в одном каталоге и два `compose up` одновременно
# оставили бы сервер в неопределённом состоянии. Ждём, а не падаем сразу, — второй
# релиз должен выкатиться следом, а не потеряться.
exec 9>/tmp/trillix-deploy.lock
if ! flock -w 600 9; then
  echo "ОШИБКА: другой деплой держит блокировку дольше 10 минут — выходим." >&2
  exit 1
fi

# Функцией, а не переменной с командой: `$VAR arg` разбивается на слова в bash, но
# НЕ в zsh — такой приём молча ломается при запуске из другой оболочки. Функция
# ведёт себя одинаково везде.
#
# `< /dev/null` — обязателен, а не гигиена. Этот скрипт подаётся на сервер ЧЕРЕЗ
# STDIN (`ssh … bash -s < deploy/remote-update.sh`), а `docker … exec` без явного
# перенаправления забирает тот же stdin себе и съедает ОСТАТОК СКРИПТА. Команды
# ниже по файлу тогда просто не выполняются, а деплой остаётся зелёным — то есть
# любая проверка после первого exec превращалась бы в декорацию.
caddy_exec() {
  docker compose --env-file .env -f deploy/compose.prod.yml exec -T caddy "$@" < /dev/null
}

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
caddy_exec caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

# Сверка, что Caddy исполняет ИМЕННО тот конфиг, который лежит в репозитории.
# Появилась после TD-27: там правки не доезжали до контейнера, а деплой был зелёный,
# потому что reload честно перечитывал устаревший файл и возвращал 0. Код возврата
# reload'а доказывает «конфиг валиден», но не «конфиг тот самый».
#
# Проверка A (обязательная): файл в контейнере == файл в репозитории. Ловит ровно
# класс TD-27 — устаревший bind-mount, недокопированную статику, не тот путь.
# Успешный reload поверх совпавшего файла уже означает, что живое соответствует репо.
echo "== сверка конфига Caddy: репозиторий → контейнер =="
host_sum=$(sha256sum deploy/caddy/Caddyfile | awk '{print $1}')
cont_sum=$(caddy_exec sha256sum /etc/caddy/Caddyfile | awk '{print $1}')
if [ "$host_sum" != "$cont_sum" ]; then
  echo "ОШИБКА: Caddyfile в контейнере не совпадает с репозиторием." >&2
  echo "  репозиторий: $host_sum" >&2
  echo "  контейнер:   $cont_sum" >&2
  echo "  Это класс TD-27: контейнер видит устаревший файл. Конфиг НЕ применён." >&2
  exit 1
fi
echo "   совпадает ($host_sum)"

# Проверка B (по возможности): живой конфиг процесса == конфиг, порождаемый файлом.
# Требует нормализации JSON (порядок ключей у adapt и admin API различается), а jq
# внутри контейнера нет — поэтому нормализуем на хосте python'ом, если он есть.
# Не обязательна: без неё гарантию даёт A + успешный reload. Молча не пропускаем —
# если нормализатора нет, честно печатаем, что глубокая сверка не выполнялась.
if command -v python3 >/dev/null 2>&1; then
  echo "== сверка конфига Caddy: файл → живой процесс =="
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT
  caddy_exec caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null > "$tmpdir/adapted.json"
  caddy_exec wget -qO- http://127.0.0.1:2019/config/ > "$tmpdir/live.json"
  if ! python3 -c '
import json,sys
d=sys.argv[1]
a=json.load(open(d+"/adapted.json")); l=json.load(open(d+"/live.json"))
sys.exit(0 if json.dumps(a,sort_keys=True)==json.dumps(l,sort_keys=True) else 1)' "$tmpdir"; then
    echo "ОШИБКА: живой конфиг Caddy не совпадает с тем, что порождает файл." >&2
    echo "  reload вернул успех, но процесс исполняет другое. Деплой остановлен." >&2
    exit 1
  fi
  echo "   живой конфиг соответствует файлу"
else
  echo "== глубокая сверка живого конфига пропущена (нет python3 для нормализации JSON) =="
fi

docker image prune -f

echo "== деплой $TAG завершён =="
