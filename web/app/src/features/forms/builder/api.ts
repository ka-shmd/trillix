import { type FormSchema } from '@entities/formSchema'

import {
  formDetailSchema,
  formSchema,
  type Form,
  type FormDetail,
} from '../../../entities/form'
import { apiRequest } from '../../../shared/api/client'

// Автосейв черновика: PATCH /forms/{id} с draftSchema + updatedAt (оптимистичная
// блокировка — бэкенд шага 2). Ответ — обновлённый Form, его updatedAt становится
// токеном для следующего сохранения.
export function saveDraftSchema(
  id: string,
  draftSchema: FormSchema,
  updatedAt: string,
): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { draftSchema, updatedAt },
    schema: formSchema,
  })
}

// Откат черновика к опубликованной версии: POST /forms/{id}/discard-draft с токеном
// той же блокировки. Ответ — деталь целиком: новый черновик и новый токен.
export function discardDraft(id: string, updatedAt: string): Promise<FormDetail> {
  return apiRequest(`/forms/${id}/discard-draft`, {
    method: 'POST',
    body: { updatedAt },
    schema: formDetailSchema,
  })
}
