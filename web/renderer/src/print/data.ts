import { z } from 'zod'

import { formSchemaSchema } from '@entities/formSchema'

// Данные печатной страницы одного ответа. Приезжают ВПЕЧАТАННЫМИ в документ
// (<script type="application/json" id="print-data">), а не запросом: страницу
// открывает headless-браузер принтера, у которого нет ни cookie, ни сессии —
// подписанный токен предъявляет api, и он же кладёт сюда готовый ответ.
//
// Разбор — тем же контрактом, что у публичной формы: схема приходит из снапшота
// версии, по которой ответ отправлен (не из черновика формы), и проверяется тем же
// Zod, что и везде. Непровалидированный any внутрь не проходит (web/CLAUDE.md).
export const printDataSchema = z.object({
  submissionId: z.string(),
  formVersion: z.number().int(),
  // Время приёма ответа в ISO-8601 (UTC). Подвал печатает его по-московски —
  // форматирование живёт на странице, а не в данных.
  submittedAt: z.string(),
  schema: formSchemaSchema,
  // Ответы — тот же формат, что в базе и в черновике рендерера: blockId → строка
  // или список строк. Ответ на вопрос, которого в этой версии нет, невозможен
  // (версия у ответа своя), а вопрос без ответа просто отсутствует в карте.
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
  // Приложенные файлы, upload_id → имя и размер. В самих ответах лежат только id;
  // без этой карты у печати не было бы ничего, кроме слова «файл».
  files: z
    .record(z.string(), z.object({ name: z.string(), size: z.number().int() }))
    .default({}),
})

export type PrintData = z.infer<typeof printDataSchema>

// readPrintData достаёт данные из документа. Отсутствие узла, битый JSON и
// несовпадение контракта — все три одинаково означают «печатать нечего»: страница
// покажет это словами, а не пустым листом, на котором ошибку не видно.
export function readPrintData(doc: Document = document): PrintData | null {
  const node = doc.getElementById('print-data')
  if (!node?.textContent) return null
  try {
    const parsed = printDataSchema.safeParse(JSON.parse(node.textContent))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
