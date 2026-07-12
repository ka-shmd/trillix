import { apiRequest } from '../../shared/api/client'
import { submissionsPageSchema, type SubmissionsPage } from '../../entities/submission'

// Транспорт submissions: страница ответов парсится Zod-схемой на границе.
export function listSubmissions(formId: string, cursor?: string): Promise<SubmissionsPage> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  const query = params.toString()
  return apiRequest(`/forms/${formId}/submissions${query ? `?${query}` : ''}`, {
    schema: submissionsPageSchema,
  })
}

// URL CSV-экспорта: обычная навигация браузера (cookie авторизует, файл качается) —
// не fetch, поэтому это абсолютный путь под /api/v1, а не вызов apiRequest.
export function submissionsExportUrl(formId: string): string {
  return `/api/v1/forms/${formId}/submissions/export`
}

// Удаление одного ответа (GDPR-гигиена): 204 без тела, требует CSRF (apiRequest сам
// добавит заголовок на не-GET).
export function deleteSubmission(formId: string, submissionId: string): Promise<void> {
  return apiRequest(`/forms/${formId}/submissions/${submissionId}`, { method: 'DELETE' })
}
