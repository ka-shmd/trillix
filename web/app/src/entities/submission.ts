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
// общий счётчик ответов формы.
export const submissionsPageSchema = z.object({
  submissions: z.array(submissionSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
})

export type SubmissionsPage = z.infer<typeof submissionsPageSchema>
