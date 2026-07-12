# Справочник схемы БД

Производная справка по таблицам, существующим на текущий момент (миграции `0001`–`0004`). **Источник истины и обоснование — `docs/ARCHITECTURE.md` §3**; при расхождении побеждает он, а эта справка правится в том же PR, что и миграция. Реальная схема всегда в `migrations/*.up.sql` (единый источник для sqlc).

## Общие принципы

- **Идентификаторы** — UUIDv7, генерируются в приложении (`domain.NewID`), упорядочены по времени создания → дружелюбны к btree.
- **Время** — `TIMESTAMPTZ`, дефолт `now()`.
- **JSONB** (`draft_schema`, `schema`) валидируется в приложении (`ValidateSchema` — `internal/domain/schema.go`), а не констрейнтами БД; на реляционные поля — `NOT NULL`/`FK`/`UNIQUE` обязательны. Формат документа — ниже, в разделе «Контракт схемы формы (JSONB)».
- **Иммутабельность** `form_versions` священна: строки этой таблицы никогда не обновляются (только INSERT при публикации).

## Связи

```
users ──< workspace_members >── workspaces ──< forms ──< form_versions
  │                                              │            │
  └──< sessions                                  └─ published_version_id ─┘  (FK на form_versions)
                                                 │
                                    submissions >─┴─> form_versions   (ответ привязан к версии)
```

Форма принадлежит **воркспейсу**, не пользователю напрямую: доступ определяется членством (`workspace_members`) — это граница авторизации и основа анти-IDOR. В MVP у пользователя один личный воркспейс (создаётся при регистрации, UI его не показывает).

---

## `users` (0002)

Учётные записи.

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | `UUID` | PK |
| `email` | `TEXT` | `NOT NULL`, `UNIQUE`, `CHECK (email = lower(email))` |
| `password_hash` | `TEXT` | `NOT NULL` — argon2id (не логируется) |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

## `workspaces` (0002)

Контейнер владения формами. Закладывается сразу, хотя команд в MVP нет: перевод single-user на команды задним числом — болезненная миграция.

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | `UUID` | PK |
| `name` | `TEXT` | `NOT NULL` |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

## `workspace_members` (0002)

Членство пользователей в воркспейсах (M2M) — механизм авторизации.

| Колонка | Тип | Ограничения |
|---|---|---|
| `workspace_id` | `UUID` | `NOT NULL`, FK → `workspaces(id)` `ON DELETE CASCADE` |
| `user_id` | `UUID` | `NOT NULL`, FK → `users(id)` `ON DELETE CASCADE` |
| `role` | `TEXT` | `NOT NULL DEFAULT 'owner'` — `owner | editor` (на будущее) |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| | | PK `(workspace_id, user_id)` |

## `sessions` (0002)

Серверные сессии (не JWT: мгновенный отзыв). Хранится только SHA-256 токена.

| Колонка | Тип | Ограничения |
|---|---|---|
| `token_hash` | `BYTEA` | PK — SHA-256 от сырого токена (не логируется) |
| `user_id` | `UUID` | `NOT NULL`, FK → `users(id)` `ON DELETE CASCADE` |
| `expires_at` | `TIMESTAMPTZ` | `NOT NULL` |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

**Индексы:** `idx_sessions_expires (expires_at)` — для фоновой чистки истёкших.

## `forms` (0003)

Формы как сущности. Мутабельный черновик (`draft_schema`) + иммутабельные версии (`form_versions`).

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | `UUID` | PK |
| `workspace_id` | `UUID` | `NOT NULL`, FK → `workspaces(id)` `ON DELETE CASCADE` |
| `title` | `TEXT` | `NOT NULL DEFAULT 'Untitled form'` |
| `slug` | `TEXT` | `NOT NULL`, `UNIQUE` — публичный id, nanoid(10) |
| `status` | `TEXT` | `NOT NULL DEFAULT 'draft'` — `draft | published | closed` |
| `draft_schema` | `JSONB` | `NOT NULL DEFAULT '{"blocks": []}'` |
| `published_version_id` | `UUID` | FK → `form_versions(id)`; ставится при публикации (фаза 4) |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| `updated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` (двигается вручную при update) |

**Индексы:** `idx_forms_workspace (workspace_id, updated_at DESC, id DESC)` — список воркспейса по свежести правки; `id` в хвосте — tie-break составного курсора `(updated_at, id)`.

## `form_versions` (0003)

Иммутабельные снапшоты черновика на момент публикации. Таблица заведена в фазе 2 ради FK-цели `forms.published_version_id`; наполняется публикацией в фазе 4.

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | `UUID` | PK |
| `form_id` | `UUID` | `NOT NULL`, FK → `forms(id)` `ON DELETE CASCADE` |
| `version` | `INT` | `NOT NULL` |
| `schema` | `JSONB` | `NOT NULL` — иммутабельный снапшот |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| | | `UNIQUE (form_id, version)` |

---

## Контракт схемы формы (JSONB)

Содержимое `forms.draft_schema` и `form_versions.schema` — один документ единого формата (**ARCHITECTURE §3.4** — источник истины). Зеркальные реализации контракта: Go-типы и валидатор `ValidateSchema` в `internal/domain/schema.go`; Zod-схема `formSchemaSchema` в `web/shared/entities/formSchema.ts` (общая для кабинета и рендерера). Любая правка формата меняет оба места одним PR с тестами обеих сторон.

```jsonc
{
  "schemaVersion": 1,              // опционально; отсутствует → трактуется как 1
  "blocks": [
    {
      "id": "blk_9f2k1x",          // стабильный, генерируется клиентом; уникален в форме
      "type": "short_text",         // short_text | long_text | email | number
                                    // | single_choice | multi_choice | date
      "label": "Ваше имя",
      "description": "",            // опционально
      "required": true,             // опционально, по умолчанию false
      "settings": {                 // опционально; у не-choice пуст
        "options": [                // только у single_choice / multi_choice
          { "id": "opt_1", "label": "Друзья" }
        ]
      }
    }
  ]
}
```

Валидатор строгий (лишние поля запрещены). Это валидатор **черновика**: пустой `label` и choice без опций допустимы — недособранное состояние, которое автосейв обязан хранить; требование «непустой label, ≥1 опция» — правило момента публикации (фаза 4).

**Лимиты** (те же числа в Go и Zod):

| Что | Предел |
|---|---|
| блоков в форме | ≤ 200 |
| опций в choice-блоке | ≤ 100 |
| длина `label` | ≤ 1000 |
| длина `description` | ≤ 2000 |
| длина `label` опции | ≤ 500 |
| длина `id` | ≤ 64 |

---

## `submissions` (0004)

Ответы респондентов; наполняется приёмом ответа (фаза 5). Каждый ответ привязан к **конкретной** опубликованной версии формы (`form_version_id`), чтобы позднейшие правки схемы не искажали уже собранные данные. `id` генерирует клиент (UUIDv7) — повторная отправка после сетевого сбоя упирается в PK и не создаёт дубля (идемпотентность). Содержимое `answers` валидируется в приложении (`ValidateAnswers` — `internal/domain/answers.go`) против схемы указанной версии.

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | `UUID` | PK (UUIDv7, генерируется клиентом) |
| `form_id` | `UUID` | `NOT NULL`, FK → `forms(id)` `ON DELETE CASCADE` |
| `form_version_id` | `UUID` | `NOT NULL`, FK → `form_versions(id)` |
| `answers` | `JSONB` | `NOT NULL` — `{ "<block_id>": <значение> }` |
| `meta` | `JSONB` | `NOT NULL DEFAULT '{}'` — user_agent, referer (без IP в открытом виде) |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

**Индексы:**
- `idx_submissions_form_id (form_id, id DESC)` (0005) — курсорный листинг ответов формы новыми сверху (фаза 6): `id` (UUIDv7) монотонен по времени, а `created_at` при пакетной вставке нестабилен, поэтому курсор и сортировка идут по `id`. Индекс покрывает фильтр по `form_id` и keyset/сортировку по `id` одной структурой.
- `idx_submissions_form (form_id, created_at DESC)` (0004) — исходный сортировочный индекс листинга.

**Формат `answers`** (зеркалит клиентский тип `Answer`, `web/shared/fields/answer.ts`): текстовые типы и `single_choice` — строка; `multi_choice` — массив id выбранных опций; `number`/`date` хранятся строкой, формат проверяет `ValidateAnswers`.
