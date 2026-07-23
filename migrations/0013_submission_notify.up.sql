-- 0013: уведомление владельцу о новом ответе (почтовая фаза, слайс D).
--
-- forms.notify_on_submission — живая настройка (колонка, как close_at/response_limit
-- из 0007, а не поле схемы): владелец меняет тумблер без перепубликации, проверка
-- идёт против текущего значения. Новые формы — с уведомлением (DEFAULT true).
ALTER TABLE forms ADD COLUMN notify_on_submission BOOLEAN NOT NULL DEFAULT true;

-- outbox.coalesce_key — ключ коалесинга для троттлинг-дайджеста (слайс D): пока
-- письмо ещё не отправлено, повторные события с тем же ключом не плодят строки, а
-- инкрементят счётчик в payload (см. mail/queries.sql EnqueueCoalescedOutbox).
-- Транзакционные письма (сброс, подтверждение) ключа не имеют (NULL) — не коалесятся.
ALTER TABLE outbox ADD COLUMN coalesce_key TEXT;

-- Уникальность ключа среди неотправленных строк — арбитр для ON CONFLICT.
-- Частичный по sent_at IS NULL: отправленный дайджест выходит из индекса, и
-- следующий ответ заводит новую строку (новое окно), а не воскрешает старую.
CREATE UNIQUE INDEX idx_outbox_coalesce ON outbox (coalesce_key) WHERE sent_at IS NULL;
