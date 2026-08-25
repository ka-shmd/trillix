import { apiRequest } from '../../shared/api/client'
import { submissionsPageSchema, type SubmissionsPage } from '../../entities/submission'
import { formSummarySchema, type FormSummary } from '../../entities/summary'
import { submissionsCountSchema, type SubmissionsCount } from '../../entities/submission'
import { periodRange, type Period } from '../../shared/period'

// Транспорт submissions: страница ответов парсится Zod-схемой на границе.
export function listSubmissions(formId: string, cursor?: string): Promise<SubmissionsPage> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  const query = params.toString()
  return apiRequest(`/forms/${formId}/submissions${query ? `?${query}` : ''}`, {
    schema: submissionsPageSchema,
  })
}

// Сводка ответов: агрегат считает сервер, сюда приходят только счётчики. Окно
// наблюдения режет ответы по времени приёма — как и все экраны аналитики.
export function getSummary(formId: string, period: Period): Promise<FormSummary> {
  const query = new URLSearchParams(periodRange(period)).toString()
  return apiRequest(`/forms/${formId}/submissions/summary${query ? `?${query}` : ''}`, {
    schema: formSummarySchema,
  })
}

// Число ответов за период — карточка над вкладками аналитики. Своя ручка, а не поле
// в счётчиках визитов: это второе независимое множество (docs/ANALYTICS.md §1).
export function getSubmissionsCount(formId: string, period: Period): Promise<SubmissionsCount> {
  const query = new URLSearchParams(periodRange(period)).toString()
  return apiRequest(`/forms/${formId}/submissions/count${query ? `?${query}` : ''}`, {
    schema: submissionsCountSchema,
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
