import { z } from 'zod'

// Доменные типы ответов (submissions) кабинета. Единственный источник —
// эти Zod-схемы (web/CLAUDE.md), зеркалят DTO из internal/submissions/handler.go.

// Значение одного ответа: текст/single_choice — строка, multi_choice — массив id
// опций (тот же формат, что @fields/answer.ts). Карта block_id → значение.
export const answerValueSchema = z.union([z.string(), z.array(z.string())])
export type AnswerValue = z.infer<typeof answerValueSchema>

export const submissionSchema = z.object({
  id: z.string(),
  // Номер версии формы, по которой отправлен ответ (в таблице — колонка «версия»).
  formVersion: z.number().int(),
  createdAt: z.string(),
  answers: z.record(z.string(), answerValueSchema),
})

export type Submission = z.infer<typeof submissionSchema>

// GET /forms/{id}/submissions: страница + непрозрачный курсор (null — последняя) +
// счётчики. total — сколько ВИДНО; hidden — сколько скрыто квотой тарифа (0014):
// эти ответы сохранены и откроются после перехода на план, который их вмещает.
// Приложенный файл (фаза 24): id загрузки → имя и размер. Отдельной картой рядом
// со страницей, а не внутри answers: в самом ответе лежат ТОЛЬКО id, и правда о
// файле живёт на сервере. Ссылки здесь нет намеренно — подпись хранилища живёт
// минуту и протухла бы раньше, чем автор доскроллит; скачивание идёт через
// GET /api/v1/files/{id}.
export const answerFileSchema = z.object({
  name: z.string(),
  size: z.number().int(),
})
export type AnswerFile = z.infer<typeof answerFileSchema>

export const submissionsPageSchema = z.object({
  submissions: z.array(submissionSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
  hidden: z.number().int(),
  // Пусто у форм без вопросов-файлов — сервер поле не печатает вовсе.
  files: z.record(z.string(), answerFileSchema).default({}),
})

export type SubmissionsPage = z.infer<typeof submissionsPageSchema>
