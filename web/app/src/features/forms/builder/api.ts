import { type FormSchema } from '@entities/formSchema'

import { formSchema, type Form } from '../../../entities/form'
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
