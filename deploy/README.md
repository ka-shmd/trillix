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
`compose.prod.yml` использует относительные пути (`./caddy`, `./static`), поэтому
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
# Бакет файлов в ответах (фаза 24). ПРИВАТНЫЙ: публичного чтения у него нет и быть
# не должно — файлы респондентов отдаются только по короткой подписи и вложением.
S3_FILES_BUCKET=app-files
# Внешний адрес хранилища — тот, по которому файл кладёт БРАУЗЕР респондента (имя
# хоста входит в подпись). На проде совпадает с S3_ENDPOINT.
S3_PUBLIC_ENDPOINT=https://<s3-host>
S3_PATH_STYLE=true    # true у path-style провайдеров (Selectel/Yandex/MinIO), false у AWS virtual-hosted
MEDIA_UPSTREAM=https://<s3-host>
MEDIA_UPSTREAM_HOST=<s3-host>

# --- бэкапы БД: S3 ДРУГОГО провайдера, чем медиа (Yandex Object Storage; см. «Бэкапы») ---
BACKUP_S3_ENDPOINT=https://storage.yandexcloud.net
BACKUP_S3_REGION=ru-central1
BACKUP_S3_ACCESS_KEY=__YANDEX_SA_ACCESS_KEY__
BACKUP_S3_SECRET_KEY=__YANDEX_SA_SECRET_KEY__
BACKUP_S3_BUCKET=trillix-backups
BACKUP_AGE_RECIPIENT=age1__PASTE_PUBLIC_KEY__
# Копировать ли в бэкап бакет файлов ответов (фаза 24). Выключено по умолчанию:
# копия растёт с числом ответов и оплачивается местом и трафиком у второго
# провайдера. Что теряется при выключенном — RESTORE.md §4.5.
BACKUP_FILES=0

# --- исходящая почта: Yandex Postbox (почтовая фаза) ---
# MAIL_TRANSPORT=smtp — прод шлёт письма настоящим SMTP (тот же транспорт, что
# репетирует prod-local в Mailpit). MAIL_FROM — адрес на подтверждённом в Postbox
# домене (иначе DKIM не подпишет и письма уйдут в спам). MAIL_SMTP_* — параметры
# Postbox: см. раздел «Почта (Yandex Postbox)» ниже (создание отправителя, DNS, ключ).
# Учётка — API-ключ сервисного аккаунта (простой путь, без конвертации): username =
# идентификатор API-ключа, password = его секрет как есть. Секрет — только здесь.
MAIL_TRANSPORT=smtp
MAIL_FROM=Trillix <no-reply@trillix.ru>
MAIL_SMTP_HOST=postbox.cloud.yandex.net
MAIL_SMTP_PORT=587
MAIL_SMTP_TLS=starttls
MAIL_SMTP_USERNAME=__POSTBOX_API_KEY_ID__
MAIL_SMTP_PASSWORD=__POSTBOX_API_KEY_SECRET__

# --- вход через Яндекс ID (фаза 11) ---
# ОПЦИОНАЛЬНЫЕ и парные: обе заданы — кнопка «Войти через Яндекс» работает; обе
# пусты — провайдер выключен, кабинет работает как раньше; заполнена ровно одна —
# api падает при старте (это опечатка, а не намерение).
# Приложение ПРОДА — отдельное от dev-приложения: dev-ключ живёт на машине
# разработчика и в истории команд, его утечка не должна касаться прода.
# Redirect URI в консоли oauth.yandex.ru обязан совпасть байт в байт:
#   https://app.trillix.ru/api/v1/auth/oauth/yandex/callback
# Из доступов нужен только «Адрес электронной почты».
YANDEX_OAUTH_CLIENT_ID=__YANDEX_PROD_CLIENT_ID__
YANDEX_OAUTH_CLIENT_SECRET=__YANDEX_PROD_CLIENT_SECRET__

# --- интеграция с Google Таблицами (фаза 25) ---
# Приложение в Google Cloud, OAuth-клиент типа «Web application».
# Redirect URI обязан совпасть байт в байт:
#   https://app.trillix.ru/api/v1/integrations/google/callback
# Scope: openid, email, https://www.googleapis.com/auth/drive.file.
# Обе строки пустые = интеграция выключена (кабинет работает как раньше).
GOOGLE_OAUTH_CLIENT_ID=__GOOGLE_PROD_CLIENT_ID__
GOOGLE_OAUTH_CLIENT_SECRET=__GOOGLE_PROD_CLIENT_SECRET__
# Браузерный API-key того же проекта — окно выбора файла на Диске.
# Требует включённого Google Picker API; в консоли ограничить по HTTP-referrer
# (https://app.trillix.ru/*) и по API. Пусто = кнопки выбора нет.
GOOGLE_PICKER_API_KEY=__GOOGLE_PICKER_API_KEY__
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

> Как устроен **конвейер целиком** (какие workflow'ы, что запускается когда, состав
> проверок, самопроверки деплоя, грабли) — **[`docs/CI-CD.md`](../docs/CI-CD.md)**.
> Здесь — операции на самом сервере.

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
`lb_try_duration 5s` / `lb_try_interval 250ms` — запрос удерживается и повторяется,
пока приложение поднимается.

**Число взято из замера, а не «с запасом»** (первая версия ставила 10s наугад):

| Что мерили | Результат |
|---|---|
| Длина щели при перезапуске | **2,07 с** (макс. задержка удержанного запроса из 120; завершился успешно) |
| Ожидание пользователя при НАСТОЯЩЕЙ смерти api | = значение параметра: 30 параллельных → 30×`502` по ~10,1 с при 10s |
| Влияние висящих запросов на прокси | нет: статика отдавалась за **0,011 с**, 30 запросов держались параллельно |

`5s` = 2,4× от измеренной щели: запас на медленный старт есть, ожидание при аварии
вдвое короче. Перепроверено после смены значения: 120 запросов, 0 ошибок, макс. 1,52 с.

**Повтор не создаёт дублей — проверено, а не выведено.** Удержание применяется и к
неидемпотентным мутациям кабинета, поэтому: 40 `POST /api/v1/forms` во время
перезапуска `api` дали **40 успехов и ровно 40 форм в БД**. Caddy переигрывает лишь
запросы, не успевшие уйти в апстрим; уже отправленный POST не повторяется.

**Почему не два экземпляра api** (щели не было бы вовсе): нужен healthcheck для
distroless-образа (там нет shell и curl), поочерёдный перезапуск в скрипте деплоя
(`up -d` перезапускает всё разом — щель вернулась бы) и вдвое больше памяти на одном
VPS. Три новых движущихся части ради двух секунд, которые удержание закрывает
полностью. Пересмотреть, если появится второй сервер или требование к SLA.

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
> **Теперь это проверяет сам деплой** (`remote-update.sh`), а не память человека —
> двумя дополняющими сверками, любая из которых валит выкатку:
> - **A:** `sha256` файла в репозитории == в контейнере (ловит класс TD-27: контейнер
>   видит устаревший файл);
> - **B:** конфиг, порождаемый файлом, == конфиг живого процесса из админ-API (ловит
>   «reload вернул успех, но не применился»). Требует `python3` на сервере для
>   нормализации JSON — без него сверка честно печатает, что пропущена.
>
> Проверено мутацией: правка Caddyfile без reload → **A проходит, B краснеет**.
>
> Посмотреть живой конфиг руками:
>
> ```bash
> docker compose --env-file .env -f deploy/compose.prod.yml exec -T caddy \
>   wget -qO- http://127.0.0.1:2019/config/ | grep -o 'try_duration' | wc -l   # ждём 3
> ```

## Почта (Yandex Postbox)

Транзакционные письма (подтверждение почты, сброс пароля, уведомление владельцу о
новом ответе) прод шлёт через **Yandex Cloud Postbox** — тот же аккаунт Облака, где
лежат бэкапы. prod-local репетирует ту же отправку в Mailpit тем же SMTP-транспортом;
различие контуров — только в значениях `MAIL_SMTP_*`. Выбор провайдера и «один
транспорт на оба контура» — ADR §10.

Бесплатно первые 2000 писем/месяц — на объёме MVP хватает с запасом.

### Однократный провижининг

1. **Создать отправителя.** Консоль Яндекс.Облака → сервис **Cloud Postbox** →
   **Создать адрес** → тип «Домен», `trillix.ru`, блок «Настройка подписи писем
   (DKIM)» → **Простая** → **Создать адрес**. Postbox покажет **две CNAME**-записи DKIM.
2. **Прописать DNS** (у регистратора `trillix.ru` — там же, где A-записи `app`/`f`;
   значения из консоли Postbox дословно):
   - **DKIM** — **две CNAME** из блока «Настройка подписи писем (DKIM)». Это и есть
     механизм подтверждения домена (отдельной «проверочной» записи нет).
   - **DMARC** — TXT на `_dmarc.trillix.ru`, значение `"v=DMARC1; p=none"` (в кавычках);
     ужесточить до `p=quarantine` после того, как mail-tester покажет прохождение.
   SPF отдельно не нужен: DMARC проходит по DKIM-выравниванию (домен подписи = домен
   `From`). Дождаться у адреса статуса **`Success`** в консоли (DNS — до 24 ч).
3. **Ключ для отправки** (простой путь — API-ключ, без конвертации). IAM →
   сервисный аккаунт (напр. `postbox-sender`) с ролью **`postbox.sender`** → создать
   ему **API-ключ** с областью действия (scope) **`yc.postbox.send`**. `username` =
   идентификатор API-ключа, `password` = его секрет **как есть**. (Статический ключ со
   скриптом `generate.py` нужен только для AWS-CLI-совместимости — нам не требуется.)
4. **В серверный `.env`** (права 600, значения — из шага 3):
   `MAIL_SMTP_USERNAME` = идентификатор API-ключа, `MAIL_SMTP_PASSWORD` = секрет,
   `MAIL_SMTP_HOST=postbox.cloud.yandex.net`, `MAIL_SMTP_PORT=587`,
   `MAIL_SMTP_TLS=starttls`, `MAIL_FROM` — адрес на подтверждённом домене
   (`no-reply@trillix.ru`). Передеплой (`remote-update.sh` или `up -d` с пересозданием
   api), чтобы контейнер перечитал env.

### Проверка

Отправить письмо на адрес [mail-tester.com](https://www.mail-tester.com) (напр.
запросить сброс пароля на выданный им ящик) и открыть отчёт — **цель ≥ 9/10**. Низкий
балл почти всегда = недоехавший DKIM/DMARC (шаг 2): проверить, что адрес получил
статус `Success` в консоли Postbox.

## Бэкапы (фаза 10, шаг 1)

`deploy/backup.sh` снимает `pg_dump -Fc`, шифрует его `age` и льёт в S3 **другого
провайдера**, чем медиа (Yandex Object Storage): отказ или компрометация reg.ru Cloud
не должны уносить сразу и данные, и бэкапы. Восстановление — [`RESTORE.md`](RESTORE.md).

**Файлы в ответах (фаза 24) — отдельный объект бэкапа.** Дамп несёт только строки
`submission_files`; сами файлы лежат в `S3_FILES_BUCKET`, и копируются они, только
если в `.env` стоит `BACKUP_FILES=1`. Шаг выключен по умолчанию осознанно: это
плата за место и трафик у второго провайдера, и решение тут владельца. При
выключенном шаге восстановленная база показывает ответы и имена вложений, но само
вложение не открывается — подробности и обратная синхронизация в
[`RESTORE.md`](RESTORE.md) §4.5. **Шаг не проверялся** живым прогоном.

### Однократный провижининг

1. **Инструменты на сервере:**
   ```bash
   sudo apt-get update && sudo apt-get install -y age awscli
   ```
2. **Пара ключей age.** Генерируется **не на сервере** (приватный ключ на прод не
   попадает — сервер только шифрует). На рабочей машине владельца:
   ```bash
   age-keygen -o trillix-backup-identity.txt   # приватный — в офлайн/менеджер паролей
   # строка «public key: age1...» → это BACKUP_AGE_RECIPIENT
   ```
   Приватный `identity` нужен только для восстановления; на сервере его быть не должно.
3. **Бакет и сервис-аккаунт в Yandex Object Storage.** Бакет `trillix-backups` —
   **приватный** (не public-read, в отличие от медиа). Сервис-аккаунт с правами на
   этот бакет → его ключ/секрет в `BACKUP_S3_*` (шаг 3 выше).
4. **Cron** (пользователь `deploy`, не root):
   ```bash
   ( crontab -l 2>/dev/null; \
     echo '0 */6 * * * cd /opt/trillix && ./deploy/backup.sh >> /var/log/trillix-backup.log 2>&1' \
   ) | crontab -
   sudo install -o deploy -g deploy /dev/null /var/log/trillix-backup.log
   ```

### Проверка

```bash
cd /opt/trillix && ./deploy/backup.sh          # прогнать вручную
aws --endpoint-url https://storage.yandexcloud.net s3 ls s3://trillix-backups/daily/
```

Учебное восстановление (обязательно, «не подглядывая») — по [`RESTORE.md`](RESTORE.md).
Непроверенный бэкап равен отсутствующему.

---

## Мониторинг аптайма (фаза 10, шаг 3)

Внешний мониторинг живости — **UptimeRobot** (SaaS, **вне этого VPS**: монитор на самом
сервере не заметил бы его падения). Два HTTP-монитора, интервал 5 минут, уведомление на
email:

- `https://app.trillix.ru/healthz` — Go пингует БД (`200 {"status":"ok"}` / `503
  {"status":"unavailable"}`), поэтому монитор краснеет и при мёртвом Postgres, не только
  при мёртвом `api` (это закрытые TD-7 и TD-28 — обработчик пингует базу и проксируется наружу).
- публичная форма на `f.trillix.ru` — HTML страницы формы отдаёт тот же `api`.

**Учебное падение проверено:** `docker compose … stop api` → монитор `/healthz` покраснел,
письмо «DOWN» пришло (в пробе ~1 мин; ожидаемо до ~10 мин в среднем на free-интервале 5 мин
+ доставка письма) → `up -d api` вернул зелёный.

**Осознанные поблажки владельца** к критерию плана («раз в минуту → алерт ≤2 мин, Telegram»),
обе пересмотреть **до выдачи живым пользователям**:

- интервал 5 мин (free-тариф) → алерт ~5–10 мин вместо ≤2 мин;
- **email вместо Telegram** — Telegram у UptimeRobot только на платных тарифах.

Апгрейд — платный тариф UptimeRobot (60-сек проверки + Telegram) или self-hosted Uptime Kuma
на второй машине.

---

## Логи (фаза 10, шаг 4)

Приложение пишет структурный JSON в stdout (`slog`), docker складывает его в `json-file`
**с ротацией** (`x-logging` в `compose.prod.yml`: до 5 файлов × 10 МиБ на контейнер — без
неё логи растут безгранично и однажды забивают диск, а с ним и Postgres). Ротация
применяется при **пересоздании** контейнера (`up -d` на деплое), не на лету — проверить
живой лимит: `docker inspect trillix-api-1 --format '{{json .HostConfig.LogConfig}}'`.

Каждый HTTP-запрос даёт одну сводную строку:
`{"msg":"request", method, path, pattern, status, duration, request_id}`. `pattern` —
шаблон маршрута (`GET /api/v1/forms/{id}`), по нему запросы группируются; `duration` —
в **наносекундах**; `request_id` связывает все строки одного запроса (он же в заголовке
ответа `X-Request-Id`).

Шпаргалка (на сервере, из `/opt/trillix`; `--no-log-prefix` убирает префикс `имя | `,
чтобы вывод был чистым JSON для `jq`):

```bash
# все 5xx за последний час
docker compose --env-file .env -f deploy/compose.prod.yml logs --since 1h --no-log-prefix api \
  | jq -c 'select(.msg=="request" and .status>=500)'

# запросы медленнее 1 с (duration в нс → 1000000000), с длительностью в мс
docker compose --env-file .env -f deploy/compose.prod.yml logs --no-log-prefix api \
  | jq -c 'select(.msg=="request" and .duration>1000000000)
           | {method, pattern, status, ms:(.duration/1000000)}'

# трейс одного запроса по request_id (взять из заголовка X-Request-Id или из строки ошибки)
docker compose --env-file .env -f deploy/compose.prod.yml logs --no-log-prefix api \
  | jq -c 'select(.request_id=="ВСТАВЬ_ID")'
```

---

## Нагрузочная проба (фаза 10, шаг 5)

Инструмент — `hey` (одноразовый, не в репозитории), прогон с внешней машины по живому VPS.

**Целевая нагрузка плана — 200 rps × 2 мин по `/healthz`:** 24 000 запросов, факт. 199.9 rps,
**все `200`, 0 ошибок**, p99 87 мс. VPS держит с большим запасом.

**Потолок (лесенка по `/healthz`):**

| Цель | Результат |
|---|---|
| 500 rps | чисто, 0 ошибок |
| 750 rps | ~44% `502` |
| 1000 rps | ~38% `502` |
| 2000 rps | ~28% `502`, сервер продолжает отдавать `200` |

**Потолок health-пути ≈ 500 rps.** Выше — Caddy отбрасывает избыток `502`, сервер **не падает
и восстанавливается мгновенно** (сразу после 2000 rps `/healthz` = `200` за 0.19 с). Failure mode
безопасный: сброс, не зависание.

**Rate limit на приёме ответа работает как задумано:** 100 POST пачкой на
`/public/v1/forms/{slug}/submissions` → ~20 прошли лимитер (`422` — тело невалидно, в базу
ничего не легло), 80 отбиты `429`.

**Оговорки (важны для трактовки числа):**

- `/healthz` дёшев (HTTP + один `ping` БД); **реальная отправка ответа тяжелее** (INSERT +
  advisory-lock + валидация), поэтому её потолок **ниже** ~500 rps — число выше это верхняя
  граница инфраструктуры, не пропускная способность записи.
- Снять потолок именно на запись с одного IP на проде нельзя: лимитер (правильно) отбивает
  поток `429`. Поэтому **TD-21** (contention на advisory-lock под конкурентной записью) остаётся
  не измеренным — корректный замер требует prod-local с пермиссивным лимитером.
