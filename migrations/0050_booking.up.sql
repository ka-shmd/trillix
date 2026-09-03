-- 0050: запись на время (фаза 27 DEV-PLAN, слайс A). Решения и отвергнутые
-- альтернативы — docs/ARCHITECTURE.md §10 (ADR), спека docs/design/booking.md.
--
-- Первая работа, где у формы появляется состояние ВНЕ ответа: слот занят или
-- свободен независимо от того, сколько раз форму открыли. В базе живёт только
-- ЗАНЯТОЕ (брони и блокировки); свободное считается на лету из правила, исключений
-- и занятого — крона, нарезающего слоты на горизонт вперёд, здесь нет (ADR §10).

-- Расписание = ОДИН НЕПРЕРЫВНЫЙ ПОТОК ЗАНЯТОСТИ: один человек, один кабинет, одна
-- группа — то, что физически не может быть занято дважды. Принадлежит пространству
-- по образцу форм: два бизнеса естественно ложатся на два пространства, но держать
-- оба в одном двумя расписаниями законно.
--
-- Тихая мина модели: разные расписания друг о друге НЕ ЗНАЮТ. Человек, ведущий и
-- рисование, и пение, обязан быть ОДНИМ расписанием, иначе обе формы предложат ему
-- один и тот же вторник. Лечится это именем («Мария — рисование», а не «Уроки
-- рисования») и подписью под полем имени, а не схемой.
CREATE TABLE schedules (
    id                    UUID PRIMARY KEY,                    -- UUIDv7 (domain.NewID)
    workspace_id          UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    timezone              TEXT NOT NULL,                       -- IANA («Europe/Moscow»); проверяется приложением через time.LoadLocation
    -- availability — правило по дням недели и исключения по датам одним документом
    -- (спека §5.2). JSONB, а не таблица: документ читается всегда целиком, поиска по
    -- нему нет, и меняться он обязан без миграций. Время внутри — МЕСТНОЕ время
    -- расписания, не UTC: «понедельник, 10:00» означает 10:00 у автора всегда.
    -- Структуру валидирует приложение (ValidateAvailability), а не CHECK.
    availability          JSONB NOT NULL,
    slot_minutes          INT NOT NULL,                        -- длительность приёма
    buffer_minutes        INT NOT NULL DEFAULT 0,              -- пауза между приёмами; входит в шаг сетки
    horizon_days          INT NOT NULL,                        -- на сколько дней вперёд открыта запись
    lead_minutes          INT NOT NULL,                        -- упреждение: ближе этого срока записаться нельзя
    capacity              INT NOT NULL DEFAULT 1,              -- мест в одном слоте; > 1 — это группа
    max_seats_per_booking INT NOT NULL DEFAULT 1,              -- мест в ОДНОЙ записи («приду с двумя детьми»)
    -- show_remaining — показывать ли респонденту остаток мест. Управляет ТОЛЬКО
    -- показом: пикеру остаток нужен числом всегда, иначе он не погасит слот, куда
    -- запрошенные места не влезают (спека §7).
    show_remaining        BOOLEAN NOT NULL DEFAULT false,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT schedules_slot_check     CHECK (slot_minutes BETWEEN 1 AND 1440),
    CONSTRAINT schedules_buffer_check   CHECK (buffer_minutes BETWEEN 0 AND 1440),
    CONSTRAINT schedules_horizon_check  CHECK (horizon_days BETWEEN 1 AND 365),
    CONSTRAINT schedules_lead_check     CHECK (lead_minutes >= 0),
    CONSTRAINT schedules_capacity_check CHECK (capacity >= 1),
    -- Взять в одной записи больше, чем всего мест в слоте, нельзя ни при каких
    -- настройках: такая запись не поместилась бы даже в пустой слот.
    CONSTRAINT schedules_seats_check    CHECK (max_seats_per_booking BETWEEN 1 AND capacity)
);

-- Список расписаний пространства — единственный способ, которым к ним ходят.
CREATE INDEX idx_schedules_workspace ON schedules (workspace_id, created_at DESC, id DESC);

-- Занято руками: отпуск, свои дела, «сегодня обед на час позже». Вторая половина
-- решения «источник истины о занятости — мы» (ADR §10): раз чужой календарь нашу
-- занятость не закрывает, автору нужен способ закрыть её у нас.
CREATE TABLE schedule_blocks (
    id          UUID PRIMARY KEY,
    schedule_id UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    starts_at   TIMESTAMPTZ NOT NULL,                          -- UTC: точка на оси времени, в отличие от правила
    ends_at     TIMESTAMPTZ NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT schedule_blocks_range_check CHECK (ends_at > starts_at)
);

-- Блокировки читаются диапазоном вместе с бронями, тем же запросом «что занято
-- между двумя датами».
CREATE INDEX idx_schedule_blocks_range ON schedule_blocks (schedule_id, starts_at);

-- Бронь — долгоживущая сущность со статусом, а не строка ответа: её отменяют по
-- ссылке из письма, она переживает удаление ответа, и внешний id события календаря
-- однажды прикрутится к ней колонкой (спека §12).
CREATE TABLE bookings (
    id               UUID PRIMARY KEY,
    -- CASCADE, а не RESTRICT: удаление расписания запрещено, пока у него есть живые
    -- БУДУЩИЕ записи, но проверку эту делает сервис (409 с человеческим текстом), а
    -- не ключ. Ключу «будущие» не выразить, и RESTRICT держал бы расписание вечно
    -- из-за прошлогодней записи. Прошлые брони уходят вместе с расписанием; время
    -- записи при этом остаётся в ответе формы — оно снапшот, а не ссылка (§5.6).
    schedule_id      UUID NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    form_id          UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    -- submission_id ставится в момент подтверждения; до него бронь — холд без
    -- ответа. SET NULL при удалении ответа: строка брони персональных данных не
    -- несёт (время и число мест), и прошлая запись остаётся в расписании автора.
    submission_id    UUID REFERENCES submissions(id) ON DELETE SET NULL,
    starts_at        TIMESTAMPTZ NOT NULL,                     -- UTC
    -- Длительность КОПИРУЕТСЯ в бронь: автор поменяет приём с 60 минут на 30, и уже
    -- назначенные встречи от этого сжаться не должны.
    duration_minutes INT NOT NULL,
    seats            INT NOT NULL,
    status           TEXT NOT NULL,                            -- held | confirmed | canceled
    hold_expires_at  TIMESTAMPTZ,                              -- только у held
    -- client_id — id, который клиент генерирует до отправки (тот же UUIDv7, что
    -- станет id ответа). В submission_id его положить нельзя: строки ответа в момент
    -- холда ещё нет, а FK требует существующую цель. Модель доверия та же, что у
    -- приёма ответа, где клиентский id — первичный ключ.
    client_id        UUID NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    canceled_at      TIMESTAMPTZ,
    CONSTRAINT bookings_status_check   CHECK (status IN ('held', 'confirmed', 'canceled')),
    CONSTRAINT bookings_seats_check    CHECK (seats >= 1),
    CONSTRAINT bookings_duration_check CHECK (duration_minutes BETWEEN 1 AND 1440)
);

-- Счёт занятого в слоте: «сумма мест по расписанию и точке старта». Горячий путь
-- публичной выдачи свободного времени и транзакции подтверждения под advisory-lock.
CREATE INDEX idx_bookings_slot ON bookings (schedule_id, starts_at);

-- Чистка протухших холдов (internal/periodic). Частичный: живых held в таблице
-- единицы против всех броней за всю историю.
CREATE INDEX idx_bookings_holds ON bookings (hold_expires_at) WHERE status = 'held';

-- Одна бронь на клиента в форме. Передумал и выбрал другое время — та же строка
-- переезжает, а не появляется вторая: иначе один нерешительный человек держал бы
-- половину дня. Отменённые из-под ограничения выведены — после отмены записаться
-- заново законно.
CREATE UNIQUE INDEX idx_bookings_client ON bookings (form_id, client_id)
    WHERE status <> 'canceled';

-- Ссылка формы на расписание — ЖИВАЯ КОЛОНКА, а не поле схемы (ADR §10): схема
-- замерзает при публикации, и ссылка в ней потребовала бы перепубликации на смену
-- расписания. Выбирается автором в блоке «Запись» на полотне; NULL = у формы нет
-- записи.
--
-- Ключ намеренно NO ACTION (умолчание), а не RESTRICT. Гарантия та же — формы,
-- ссылающейся на удалённое расписание, не бывает, — но проверка откладывается до
-- конца утверждения, поэтому каскад от пространства (он уносит и формы, и
-- расписания одним DELETE) проходит, а не падает от порядка обхода строк.
ALTER TABLE forms ADD COLUMN schedule_id UUID
    REFERENCES schedules(id) ON DELETE NO ACTION;

-- Обслуживает обратный вопрос «какие формы ссылаются на это расписание» — его
-- задаёт стоп-кран удаления. Частичный: колонка пуста у подавляющего большинства форм.
CREATE INDEX idx_forms_schedule ON forms (schedule_id) WHERE schedule_id IS NOT NULL;

-- Ключа тарифа здесь НЕТ намеренно: booking_schedules_max приезжает своей миграцией
-- вместе с записью в каталоге entitlements и счётчиком расхода (слайс B). План,
-- объявивший ключ, которого каталог не знает, — ошибка конфигурации, и её ловит
-- TestPlansCoverCatalog; порознь эти две правки красят тест.
