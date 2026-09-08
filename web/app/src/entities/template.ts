import { z } from 'zod'

import { formSchemaSchema } from '@entities/formSchema'

// Доменные типы шаблонов формы. Зеркалят DTO из internal/templates/handler.go.
//
// Документ шаблона парсится ОБЩЕЙ с рендерером схемой (formSchemaSchema), а не
// своим описанием «вопрос — тип — варианты»: галерея рисует не рассказ о форме, а
// саму форму, теми же кирпичами, что публичная страница. Своё описание означало
// бы второй формат документа и вторую его валидацию.
export const templateVisibilitySchema = z.enum(['private', 'public'])

export const formTemplateSchema = z.object({
  id: z.string(),
  // title/description — подпись шаблона на полке: их пишет автор, сохраняя форму.
  // Заголовок будущей формы живёт ОТДЕЛЬНО, блоком form_title внутри документа,
  // и при создании формы побеждает он.
  title: z.string(),
  description: z.string(),
  schema: formSchemaSchema,
  // visibility — на какую вкладку галереи попадает шаблон и можно ли его удалить
  // из кабинета: витрина сервиса правится только админской ручкой.
  visibility: templateVisibilitySchema,
  // workspaceId — чей шаблон; null у публичного (он не принадлежит пространству).
  workspaceId: z.string().nullable(),
})

export const templatesResponseSchema = z.object({
  items: z.array(formTemplateSchema),
})

export type FormTemplate = z.infer<typeof formTemplateSchema>
export type TemplateVisibility = z.infer<typeof templateVisibilitySchema>
