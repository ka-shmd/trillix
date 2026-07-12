import { z } from 'zod'

import { formSchemaSchema } from '@entities/formSchema'

// Доменные типы форм. Единственный источник — эти Zod-схемы (web/CLAUDE.md),
// зеркалят DTO из internal/forms/handler.go. Черновик схемы (draftSchema)
// парсится общим с рендерером formSchemaSchema прямо на границе API.
export const formStatusSchema = z.enum(['draft', 'published', 'closed'])

// Карточка формы в списке и ответ создания/переименования.
export const formSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  status: formStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  // Публикация (фаза 4). publishedVersion/publishedVersionId — null, пока форму
  // не публиковали (после закрытия сохраняются). hasUnpublishedChanges — черновик
  // разошёлся с опубликованной версией (бейдж в шапке билдера); точен на
  // GET/списке, у ответов мутаций всегда false.
  publishedVersion: z.number().int().nullable(),
  publishedVersionId: z.string().nullable(),
  hasUnpublishedChanges: z.boolean(),
})

export type Form = z.infer<typeof formSchema>

// GET /forms/{id}: карточка + черновик схемы (билдер гидрирует им свой стор).
export const formDetailSchema = formSchema.extend({
  draftSchema: formSchemaSchema,
})

export type FormDetail = z.infer<typeof formDetailSchema>

// GET /forms: страница + непрозрачный курсор на следующую (null — последняя).
export const formsPageSchema = z.object({
  forms: z.array(formSchema),
  nextCursor: z.string().nullable(),
})

export type FormsPage = z.infer<typeof formsPageSchema>
