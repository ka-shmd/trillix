# Деплой на VPS (Фаза 9)

Инструкция ввода прода в строй. Благодаря фазе 7 это **подключение**, а не разработка:
образы, `compose.prod.yml`, `Caddyfile` и релизный пайплайн уже готовы и проверены на
контуре prod-local. От prod-local настоящий прод отличается ровно четырьмя вещами
(ARCHITECTURE, «три контура»):

| | prod-local | прод (эта инструкция) |
|---|---|---|
| Домены | `app.localhost` / `f.localhost` | `app.trillix.ru` / `f.trillix.ru` |
| TLS | внутренний CA Caddy | Let's Encrypt (Caddy сам) |
| Секреты | одноразовые из `.env.prod-local` (в git) | сгенерированы заново, только в `/opt/trillix/.env` (600, не в git) |
| Медиа | MinIO в Docker | арендованный S3-совместимый |

Образы и compose — **байт в байт те же**. Ничего в коде под «прод» не ветвится: все
различия — в серверном `.env`.

**Цель чек-листа шага 1 — пересоздание сервера за 20 минут.** Если по этой инструкции
не получилось уложиться «не подглядывая» — инструкция неполна, чините её, а не память.

> Гейт фазы (шаг 0): раздел `docs/TECH-DEBT.md` §1 (блокеры) должен быть пуст. На момент
> написания — пуст (TD-1..TD-4 закрыты). Перед выкаткой сверить §1 с реальностью ещё раз:
> фазы 8.5+ могли завести новые блокеры.

---

## Предпосылки

- Домен `trillix.ru` с доступом к его DNS-записям.
- VPS с Ubuntu 24.04 LTS (или совместимой), root или sudo на первичную настройку.
- Арендованное S3-совместимое хранилище: endpoint, регион, access/secret-ключ, бакет.
- Доступ на чтение к GHCR-образу `ghcr.io/ka-shmd/trillix-api` (или сделать пакет публичным).

В примерах: `<VPS_IP>` — адрес сервера, `<TAG>` — релизный тег (напр. `v0.9.0`).

---

## Шаг 1. Подготовка и харденинг VPS

Всё выполняется на сервере под root (или через `sudo`). Цель — сервер без пароля-входа,
с межсетевым экраном и автообновлениями.

### 1.1 Пользователь деплоя без root

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# Скопировать СВОЙ публичный ключ (с рабочей машины: cat ~/.ssh/id_ed25519.pub)
printf '%s\n' 'ssh-ed25519 AAAA... you@host' > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

Проверить вход **в новом окне** (`ssh deploy@<VPS_IP>`) ДО отключения пароля — иначе
можно запереть себя снаружи.

### 1.2 Вход только по ключу, без root по SSH

В `/etc/ssh/sshd_config` (или дропин `/etc/ssh/sshd_config.d/hardening.conf`):

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
```

```bash
systemctl restart ssh
```

### 1.3 Межсетевой экран — только 22/80/443

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (Caddy: редирект на https + ACME-челлендж)
ufw allow 443/tcp   # HTTPS
ufw enable
ufw status verbose
```

Порт Postgres (5432) и S3 наружу **не** открываются: база слушает только внутреннюю
docker-сеть (в `compose.prod.yml` порт не публикуется), медиа — внешний провайдер.

### 1.4 fail2ban и автообновления безопасности

```bash
apt update
apt install -y fail2ban unattended-upgrades
systemctl enable --now fail2ban
dpkg-reconfigure -plow unattended-upgrades   # включить автоприменение security-обновлений
```

### 1.5 Docker Engine + compose-плагин

По официальной инструкции Docker для Ubuntu (репозиторий `download.docker.com`), затем:

```bash
usermod -aG docker deploy    # чтобы deploy запускал compose без sudo (перелогиниться)
docker --version && docker compose version
```

**С этого момента дальше — под пользователем `deploy`.**

---

## Шаг 2. DNS и релизная переменная

### 2.1 A-записи

Два поддомена на IP сервера (два origin, ADR §10 — кабинет и рендерер разделены):

```
app.trillix.ru.   A   <VPS_IP>
f.trillix.ru.     A   <VPS_IP>
```

Let's Encrypt Caddy включит сам при первом старте (нужны открытые 80/443 и доехавший DNS).
Выделенного домена под API нет — он same-origin под `app.trillix.ru/api`.

### 2.2 GitHub repo-переменная и перевыпуск тега

Релизный workflow (`.github/workflows/release.yml`) печёт публичную базу в бандл кабинета
на этапе сборки. Пока `VITE_PUBLIC_BASE_URL` не задан — статика собирается с заглушкой
`https://f.example.com`, и ссылки на форму в кабинете будут битыми.

1. GitHub → Settings → Secrets and variables → Actions → **Variables** → добавить
   `VITE_PUBLIC_BASE_URL = https://f.trillix.ru`.
2. **Перевыпустить тег** (иначе в Release лежит статика с заглушкой):
   ```bash
   git tag v0.9.0 && git push origin v0.9.0
   ```
   Дождаться, пока workflow «Release» соберёт образ в GHCR и приложит `trillix-static-v0.9.0.tar.gz`
   к GitHub Release.

---

## Шаг 3. Серверный `.env` (секреты, права 600)

На сервере разложить репозиторий и создать `.env` рядом с местом запуска compose.
`compose.prod.yml` использует относительные пути (`./Caddyfile`, `./static`), поэтому
запускается из корня репозитория с `-f deploy/compose.prod.yml`, а `--env-file` указывает
на `.env` в корне.

```bash
sudo install -d -o deploy -g deploy /opt/trillix
cd /opt/trillix
git clone https://github.com/ka-shmd/trillix.git .
git checkout v0.9.0        # тот же тег, что собран в шаге 2
```

Создать `/opt/trillix/.env` **с нуля** (не копировать `.env.prod-local` — там одноразовые
локальные секреты). Каждую переменную описывает `.env.example`; прод-значения:

```bash
umask 077   # чтобы .env создался с 600
cat > .env <<'EOF'
# --- контур ---
TAG=v0.9.0
HTTP_ADDR=0.0.0.0:8080
COOKIE_SECURE=true
TRUSTED_PROXY=true

# --- секреты (сгенерированы ЗАНОВО на этом сервере, НЕ из prod-local) ---
FORM_TOKEN_SECRET=__PASTE_openssl_rand_base64_32__
POSTGRES_USER=trillix
POSTGRES_PASSWORD=__PASTE_openssl_rand_base64_24__
POSTGRES_DB=trillix
DATABASE_URL=postgres://trillix:__SAME_AS_POSTGRES_PASSWORD__@postgres:5432/trillix?sslmode=disable

# --- домены и публичная часть ---
APP_DOMAIN=app.trillix.ru
RENDERER_DOMAIN=f.trillix.ru
APP_ORIGIN=https://app.trillix.ru
PUBLIC_RENDERER_BASE_URL=https://f.trillix.ru
OG_IMAGE_URL=https://f.trillix.ru/og-preview.png
PUBLIC_RENDERER_INDEX_PATH=/srv/renderer/index.html
HSTS_MAX_AGE=31536000

# --- медиа: арендованный внешний S3 (MinIO на проде НЕ поднимается, см. ниже) ---
S3_ENDPOINT=https://<s3-host>
S3_REGION=<region>
S3_ACCESS_KEY=__EXTERNAL_S3_ACCESS_KEY__
S3_SECRET_KEY=__EXTERNAL_S3_SECRET_KEY__
S3_MEDIA_BUCKET=app-media
S3_PATH_STYLE=true    # true у path-style провайдеров (Selectel/Yandex/MinIO), false у AWS virtual-hosted
MEDIA_UPSTREAM=https://<s3-host>
MEDIA_UPSTREAM_HOST=<s3-host>
EOF
chmod 600 .env
```

Сгенерировать секреты:

```bash
openssl rand -base64 32   # → FORM_TOKEN_SECRET
openssl rand -base64 24   # → POSTGRES_PASSWORD (и тот же в DATABASE_URL)
```

Бакет `app-media` на внешнем S3 должен существовать и быть **public-read без листинга**
(только GetObject) — на проде его не создаёт `createbuckets` (тот только для MinIO).
Настроить политику доступа в панели провайдера один раз.

> **Про MinIO на проде.** `compose.prod.yml` его не содержит вовсе: локальное хранилище
> вынесено в `compose.local-media.yml`, который подключается только в `make prod-local`.
> На проде поднимаются ровно `api`, `caddy`, `postgres`, `migrate`.

---

## Шаг 4. Первый деплой руками

Всё готовое скачивается, а не собирается на сервере.

```bash
cd /opt/trillix

# 1) Доступ к приватному GHCR-образу (пропустить, если пакет публичный).
#    PAT с scope read:packages, вводится в stdin — не в историю шелла.
echo "$GHCR_PAT" | docker login ghcr.io -u <github-username> --password-stdin

# 2) Статику фронтов — из GitHub Release этого тега в deploy/static/.
curl -fL -o /tmp/static.tar.gz \
  https://github.com/ka-shmd/trillix/releases/download/v0.9.0/trillix-static-v0.9.0.tar.gz
rm -rf deploy/static/app deploy/static/renderer
tar -xzf /tmp/static.tar.gz -C deploy/static

# 3) Поднять стек. migrate прогонится один раз до api; caddy возьмёт Let's Encrypt.
docker compose --env-file .env -f deploy/compose.prod.yml pull
docker compose --env-file .env -f deploy/compose.prod.yml up -d

# 4) Смоук: те же проверки, что у prod-local, но по реальным доменам.
docker compose --env-file .env -f deploy/compose.prod.yml -p trillix ps
curl -fsS https://app.trillix.ru/ -o /dev/null && echo "app OK"
curl -fsS https://f.trillix.ru/ -o /dev/null && echo "renderer OK"
curl -s -o /dev/null -w '%{http_code}\n' https://f.trillix.ru/r/nonexistent   # ждём 404
curl -sI https://app.trillix.ru/ | grep -i strict-transport-security          # HSTS присутствует
```

`scripts/prod-local-smoke.sh` — образец полного смоука (регистрация по https →
`Set-Cookie: …Secure`, мутация без `X-CSRF-Token` → 403); адаптировать домены при желании.

Глазами: `https://app.trillix.ru` — настоящий замок, полный путь пользователя; опубликовать
форму, открыть `https://f.trillix.ru/r/{slug}` с телефона из другой сети.

---

## Откат

Тег иммутабелен, образы в GHCR лежат по тегам — откат это возврат `TAG`:

```bash
cd /opt/trillix
git checkout v0.8.0                 # предыдущий тег (для Caddyfile/compose, если менялись)
sed -i 's/^TAG=.*/TAG=v0.8.0/' .env # образ api/migrate предыдущей версии
# статику предыдущего тега — тем же curl из его Release
docker compose --env-file .env -f deploy/compose.prod.yml pull
docker compose --env-file .env -f deploy/compose.prod.yml up -d
```

Миграции вперёд-совместимы в рамках MVP; откат со **снятием** миграции — вручную
(`docker compose run --rm migrate migrate down`), осторожно с потерей данных.

---

## Автодеплой (CD, шаг 5)

После первого ручного деплоя выкладка автоматизирована: релизный workflow
(`.github/workflows/release.yml`, job `deploy`) по тегу `v*` собирает образ+статику,
затем заходит на сервер по SSH и запускает `deploy/remote-update.sh`. Сервер сам тянет
готовое (образ из GHCR, статику из Release своими кредами) и перезапускает стек. Итог:
**`git tag vX.Y.Z && git push origin vX.Y.Z` → прод обновлён через пару минут**, без
ручного захода на сервер.

Настройка (один раз):

1. **Отдельный SSH-ключ для CI** (не личный): `ssh-keygen -t ed25519 -f ~/.ssh/trillix_ci_deploy -N ""`.
2. **Публичную часть — на сервер:** `ssh-copy-id -i ~/.ssh/trillix_ci_deploy.pub deploy@<VPS_IP>`
   (допишет ключ в `~deploy/.ssh/authorized_keys`).
3. **Приватную часть — в GitHub Secrets:** `gh secret set DEPLOY_SSH_KEY < ~/.ssh/trillix_ci_deploy`.
4. **Адрес и пользователь — в repo-переменные:** `gh variable set DEPLOY_HOST --body <VPS_IP>` и
   `gh variable set DEPLOY_USER --body deploy`.

Откат — тем же тегом: `git push origin` на предыдущий тег переустанавливает его на проде
(или вручную по разделу «Откат» выше).

## Выкатка без 502 (шаг 6)

`docker compose up -d` пересоздаёт контейнер `api`: между остановкой старого и
готовностью нового есть щель ~1 с. Graceful shutdown в Go её **не закрывает** — он
докручивает уже принятые запросы, а не те, что придут в щель. Замер до починки
(`scripts/deploy-no-502.sh` во время выкатки): **4 ответа `502` из 281 запроса**.

Лечится на стороне Caddy: сниппет `(apiproxy)` в `deploy/caddy/Caddyfile` даёт
`lb_try_duration 10s` / `lb_try_interval 250ms` — запрос удерживается и повторяется,
пока приложение поднимается.

Три замера на проде одним и тем же способом (пересоздание `api` под пробой):

| Замер | Конфиг Caddy | Результат |
|---|---|---|
| 1 | старый | 4×502 из 281 |
| 2 | старый (казался новым — TD-27) | 3×502 из 200 |
| 3 | новый, подтверждён админ-API | **0 из 196** |

Замер 2 — поучительный: правка была в git и «выкачена», но до контейнера не доехала
(TD-27). Поэтому проверять надо **живой конфиг**, а не факт зелёного деплоя.

Проверить самому — запустить пробу и параллельно выкатку:

```bash
scripts/deploy-no-502.sh https://f.trillix.ru/r/deploy-probe-nonexistent 120
# в это же время: git push origin vX.Y.Z  (или на сервере force-recreate api)
```

Проба бьёт в несуществующую форму: ожидаемый `404` доказывает, что жива вся цепочка
Caddy → Go → Postgres (`200` доказывал бы меньше — его отдала бы и статика при мёртвом api).

> **Важно про Caddyfile — две ловушки сразу (TD-27).**
> 1. Он примонтирован bind-mount'ом, и `up -d` контейнер `caddy` при правке файла **не
>    пересоздаёт** — новый конфиг сам по себе не применится. Поэтому `remote-update.sh`
>    делает `caddy reload` (перечитывает на живую, без разрыва соединений).
> 2. Монтируется **каталог** (`./caddy:/etc/caddy:ro`), а не файл. Одиночный bind-mount
>    файла привязан к иноде, а `git checkout` тега пишет новый файл и переименовывает —
>    контейнер продолжал бы видеть старое содержимое, и `caddy reload` честно
>    перечитывал бы устаревший файл, возвращая успех. Именно так правка `lb_try_duration`
>    «уехала» на прод, не применившись: деплой зелёный, конфиг старый.
>
> Проверить, что в живом Caddy лежит ожидаемое (а не то, что просто есть в git):
>
> ```bash
> docker compose --env-file .env -f deploy/compose.prod.yml exec -T caddy \
>   wget -qO- http://127.0.0.1:2019/config/ | grep -o 'try_duration' | wc -l   # ждём 3
> ```

## Оставшееся по фазе 9 (следующие срезы)

Сделано: чек-лист харденинга + runbook (шаги 1–4), HSTS (TD-13), автодеплой по SSH (шаг 5),
вынос MinIO в override `compose.local-media.yml` (прод-файл описывает ровно прод),
выкатка без 502 (шаг 6).
Ещё предстоит (каждое — свой PR/срез):

- **Шаг 7 — внешняя проверка безопасности:** `nmap` с другой машины (открыты только
  22/80/443), Mozilla Observatory по заголовкам (HSTS/CSP/nosniff/frame-options).
- **TD-7** (`/healthz` не пингует БД) — до фазы 10, иначе мониторинг зелёный при мёртвом Postgres.
