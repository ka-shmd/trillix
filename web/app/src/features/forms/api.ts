import { apiRequest } from '../../shared/api/client'
import {
  formSchema,
  formDetailSchema,
  formsPageSchema,
  type Form,
  type FormDetail,
  type FormsPage,
} from '../../entities/form'

// Транспорт forms: каждый ответ парсится Zod-схемой на границе; delete — 204 без тела.

export function listForms(cursor?: string): Promise<FormsPage> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  const query = params.toString()
  return apiRequest(`/forms${query ? `?${query}` : ''}`, { schema: formsPageSchema })
}

export function getForm(id: string): Promise<FormDetail> {
  return apiRequest(`/forms/${id}`, { schema: formDetailSchema })
}

export function createForm(title?: string): Promise<Form> {
  return apiRequest('/forms', {
    method: 'POST',
    body: title ? { title } : {},
    schema: formSchema,
  })
}

export function renameForm(id: string, title: string): Promise<Form> {
  return apiRequest(`/forms/${id}`, { method: 'PATCH', body: { title }, schema: formSchema })
}

export function deleteForm(id: string): Promise<void> {
  return apiRequest(`/forms/${id}`, { method: 'DELETE' })
}
