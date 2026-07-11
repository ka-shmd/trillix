import { z } from 'zod'

// Доменные типы форм. Единственный источник — эти Zod-схемы (web/CLAUDE.md),
// зеркалят DTO из internal/forms/handler.go. Схема блоков черновика появится в
// фазе 3 (общая с рендерером); пока draftSchema — непрозрачный JSON.
export const formStatusSchema = z.enum(['draft', 'published', 'closed'])

// Карточка формы в списке и ответ создания/переименования.
export const formSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  status: formStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Form = z.infer<typeof formSchema>

// GET /forms/{id}: карточка + черновик схемы (для заглушки редактора фазы 2).
export const formDetailSchema = formSchema.extend({
  draftSchema: z.unknown(),
})

export type FormDetail = z.infer<typeof formDetailSchema>

// GET /forms: страница + непрозрачный курсор на следующую (null — последняя).
export const formsPageSchema = z.object({
  forms: z.array(formSchema),
  nextCursor: z.string().nullable(),
})

export type FormsPage = z.infer<typeof formsPageSchema>
