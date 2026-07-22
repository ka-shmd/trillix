# Восстановление БД из бэкапа

> Непроверенный бэкап равен отсутствующему. Эта процедура — не документация «на
> будущее», а то, что должно быть **воспроизведено руками** (владельцем, через неделю,
> не подглядывая — Definition of Done фазы 10). Прогнав её, впишите замер времени в
> конец файла.

Бэкапы снимает [`backup.sh`](backup.sh): `pg_dump -Fc` → шифрование `age` на публичный
ключ → S3 (Yandex Object Storage, отдельный от медиа провайдер). Ключи:

- `daily/trillix-ГГГГ-ММ-ДД-ЧЧММ.sql.age` — каждые 6 часов, хранится 14 суток;
- `weekly/trillix-ГГГГ-ММ-ДД-Wнн.sql.age` — снимок по понедельникам, хранится 8 недель.

## Что нужно под рукой

1. **Приватный ключ age** (`identity`). На сервере его НЕТ — сервер умеет только
   шифровать. Ключ лежит офлайн у владельца (менеджер паролей / офлайн-носитель).
   Без него бэкап не расшифровать — это и есть смысл офсайт-шифрования. Файл вида:
   ```
   # created: ...
   # public key: age1...    ← это BACKUP_AGE_RECIPIENT
   AGE-SECRET-KEY-1........
   ```
2. **Креды S3-бакета бэкапов** (`BACKUP_S3_*`) — на чтение достаточно.
3. **`age`, `awscli`, `docker`** на машине, где восстанавливаете.

## Процедура

Засеките время с этого места.

### 1. Скачать вчерашний бэкап

```bash
export AWS_ACCESS_KEY_ID=...        # BACKUP_S3_ACCESS_KEY
export AWS_SECRET_ACCESS_KEY=...    # BACKUP_S3_SECRET_KEY
export AWS_DEFAULT_REGION=ru-central1
EP=https://storage.yandexcloud.net  # BACKUP_S3_ENDPOINT
BUCKET=...                          # BACKUP_S3_BUCKET

# посмотреть, что есть, и взять последний суточный
aws --endpoint-url "$EP" s3 ls "s3://$BUCKET/daily/"
aws --endpoint-url "$EP" s3 cp "s3://$BUCKET/daily/trillix-ГГГГ-ММ-ДД-ЧЧММ.sql.age" ./dump.sql.age
```

### 2. Расшифровать

```bash
age -d -i ~/age-identity.txt -o dump.sql dump.sql.age
```

Ошибка `no identity matched` → взят не тот приватный ключ (публичный в заголовке
бэкапа не совпал с вашим `identity`).

### 3. Поднять чистый Postgres и восстановить

Отдельный контейнер, чтобы не задеть рабочую базу:

```bash
docker run -d --name trillix-restore -e POSTGRES_PASSWORD=restore \
  -e POSTGRES_USER=trillix -e POSTGRES_DB=trillix -p 55432:5432 postgres:16
# дождаться готовности
until docker exec trillix-restore pg_isready -U trillix -d trillix; do sleep 1; done

# кастомный формат (-Fc) восстанавливается pg_restore, не psql
cat dump.sql | docker exec -i trillix-restore \
  pg_restore -U trillix -d trillix --clean --if-exists --no-owner
```

`--clean --if-exists` делает шаг идемпотентным (повторный прогон не падает на
существующих объектах). Предупреждения о несуществующих объектах при первом
`--clean` — норма.

### 4. Проверить, что приложение с базой работает

Быстрая проверка целостности — данные на месте:

```bash
docker exec trillix-restore psql -U trillix -d trillix -c \
  "SELECT (SELECT count(*) FROM forms)        AS forms,
          (SELECT count(*) FROM submissions)  AS submissions,
          (SELECT count(*) FROM form_visits)  AS visits;"
```

Полная проверка — поднять `api` против восстановленной базы (укажите в его
`DATABASE_URL` порт `55432`) и открыть кабинет: вчерашние формы на месте, ответы
открываются, сводка считается.

### 5. Убрать за собой

```bash
docker rm -f trillix-restore
rm -f dump.sql dump.sql.age
```

Остановите таймер.

## Замеры

Каждый учебный прогон — новая строка (append-only): дата, кто, полное время «от
скачивания до открытого кабинета», что мешало.

> **Замер зависит от размера базы.** Время ниже снято на почти пустой БД (~20 КБ).
> На загруженной базе и скачивание из Yandex, и `pg_restore` вырастут — перемеряй
> хронометраж, когда данных станет заметно больше, иначе цифра вводит в заблуждение.

| Дата | Кто | Время | Заметки |
|---|---|---|---|
| 2026-07-22 | владелец | < 1 мин (скачивание ~5 с) | первый прогон; БД ~20 КБ (5 форм, 16 визитов, 0 ответов) — **нерепрезентативно** для нагруженной базы; проверка целостности сошлась |
