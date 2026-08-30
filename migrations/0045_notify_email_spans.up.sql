-- 0045: тема и текст письма о новом ответе — СПАНЫ вместо плоских строк
-- (docs/design/mentions.md §10, ADR §10). Спан с полем `ref` — подстановка ответа,
-- и без массива её негде хранить.
--
-- Формат меняется в лоб, а не принимается в обоих видах: колонка живая, версии у
-- неё нет, и развилку «строка или массив» пришлось бы держать в Zod, в Go и в SQL
-- навсегда.
--
-- Окно выкатки безопасно в обе стороны и без второго релиза: и старый бинарь на
-- новом формате, и новый на старом получают из notifyEmailFromJSON nil, то есть
-- письмо уходит ДЕФОЛТНЫМ шаблоном. Уведомление не теряется, теряется перебивка
-- автора — и только на те секунды, пока идёт деплой.
--
-- Пустых строк в колонке не бывает (omitempty их не пишет), но COALESCE стоит:
-- ключ, которого нет, и ключ с пустой строкой обязаны дать одно и то же — ОТСУТСТВИЕ
-- ключа, а не массив с пустым куском (у пустоты одно представление, mentions.md §3).
UPDATE forms
   SET notify_email = (notify_email - 'subject' - 'body')
       || CASE
            WHEN COALESCE(notify_email ->> 'subject', '') = '' THEN '{}'::jsonb
            ELSE jsonb_build_object('subject',
                   jsonb_build_array(jsonb_build_object('t', notify_email -> 'subject')))
          END
       || CASE
            WHEN COALESCE(notify_email ->> 'body', '') = '' THEN '{}'::jsonb
            ELSE jsonb_build_object('body',
                   jsonb_build_array(jsonb_build_object('t', notify_email -> 'body')))
          END
 WHERE notify_email IS NOT NULL
   AND (jsonb_typeof(notify_email -> 'subject') = 'string'
     OR jsonb_typeof(notify_email -> 'body') = 'string');
