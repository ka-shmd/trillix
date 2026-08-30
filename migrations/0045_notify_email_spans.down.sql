-- Откат склеивает спаны обратно в плоскую строку по полю `t`.
--
-- Откат ТЕРЯЕТ подстановки, и это неизбежно: чип превращается в своё имя («Имя»),
-- потому что в плоской строке ссылке жить негде. Текст письма при этом остаётся
-- читаемым — ровно то же, что уезжает в CSV и в og:description (PlainText).
UPDATE forms
   SET notify_email = (notify_email - 'subject' - 'body')
       || CASE
            WHEN jsonb_typeof(notify_email -> 'subject') <> 'array'
              OR jsonb_array_length(notify_email -> 'subject') = 0 THEN '{}'::jsonb
            ELSE jsonb_build_object('subject', (
                   SELECT string_agg(e ->> 't', '' ORDER BY ord)
                     FROM jsonb_array_elements(notify_email -> 'subject')
                          WITH ORDINALITY AS a(e, ord)))
          END
       || CASE
            WHEN jsonb_typeof(notify_email -> 'body') <> 'array'
              OR jsonb_array_length(notify_email -> 'body') = 0 THEN '{}'::jsonb
            ELSE jsonb_build_object('body', (
                   SELECT string_agg(e ->> 't', '' ORDER BY ord)
                     FROM jsonb_array_elements(notify_email -> 'body')
                          WITH ORDINALITY AS a(e, ord)))
          END
 WHERE notify_email IS NOT NULL
   AND (jsonb_typeof(notify_email -> 'subject') = 'array'
     OR jsonb_typeof(notify_email -> 'body') = 'array');
