import { apiRequest } from '../../shared/api/client'
import {
  partialSubmissionsPageSchema,
  submissionsPageSchema,
  type PartialSubmissionsPage,
  type SubmissionsPage,
} from '../../entities/submission'
import {
  blockAnswersPageSchema,
  formSummarySchema,
  type BlockAnswersPage,
  type FormSummary,
} from '../../entities/summary'
import { submissionsCountSchema, type SubmissionsCount } from '../../entities/submission'
import { periodRange, type Period } from '../../shared/period'

// Транспорт submissions: страница ответов парсится Zod-схемой на границе.
//
// kind выбирает МНОЖЕСТВО, а не вид: `all` — отправленные и незавершённые одним
// списком по времени (вкладка «Все ответы»), `completed` — только отправленные.
// Курсор внутри у них разный, но клиент его не разбирает: непрозрачная строка
// уезжает обратно вместе с тем же kind.
export function listSubmissions(
  formId: string,
  kind: SubmissionsKind,
  cursor?: string,
): Promise<SubmissionsPage> {
  const params = new URLSearchParams()
  if (kind === 'all') params.set('kind', 'all')
  if (cursor) params.set('cursor', cursor)
  const query = params.toString()
  return apiRequest(`/forms/${formId}/submissions${query ? `?${query}` : ''}`, {
    schema: submissionsPageSchema,
  })
}

// Какое множество показывает вкладка раздела «Ответы».
export type SubmissionsKind = 'all' | 'completed'

// Сводка ответов: агрегат считает сервер, сюда приходят только счётчики. Окно
// наблюдения режет ответы по времени приёма — как и все экраны аналитики.
export function getSummary(formId: string, period: Period): Promise<FormSummary> {
  const query = new URLSearchParams(periodRange(period)).toString()
  return apiRequest(`/forms/${formId}/submissions/summary${query ? `?${query}` : ''}`, {
    schema: formSummarySchema,
  })
}

// Все значения одного вопроса, страницами. Период тот же, что у сводки: открыв
// окно из строки «Ответили 12 из 34» за неделю, владелец обязан увидеть те же
// двенадцать, а не всё время.
export function listBlockAnswers(
  formId: string,
  blockId: string,
  period: Period,
  cursor?: string,
): Promise<BlockAnswersPage> {
  const params = new URLSearchParams(periodRange(period))
  if (cursor) params.set('cursor', cursor)
  const query = params.toString()
  return apiRequest(
    `/forms/${formId}/submissions/summary/${encodeURIComponent(blockId)}${query ? `?${query}` : ''}`,
    { schema: blockAnswersPageSchema },
  )
}

// Число ответов за период — карточка над вкладками аналитики. Своя ручка, а не поле
// в счётчиках визитов: это второе независимое множество (docs/ANALYTICS.md §1).
export function getSubmissionsCount(formId: string, period: Period): Promise<SubmissionsCount> {
  const query = new URLSearchParams(periodRange(period)).toString()
  return apiRequest(`/forms/${formId}/submissions/count${query ? `?${query}` : ''}`, {
    schema: submissionsCountSchema,
  })
}

// Черновики формы, страницами. Своя ручка, а не ?kind= у листинга ответов: другая
// таблица, другой курсор (составной) и свой гейт тарифа — 402 отсюда кабинет читает
// как «показать плашку», а не как сбой.
export function listPartials(formId: string, cursor?: string): Promise<PartialSubmissionsPage> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  const query = params.toString()
  return apiRequest(`/forms/${formId}/partials${query ? `?${query}` : ''}`, {
    schema: partialSubmissionsPageSchema,
  })
}

// Удаление одного черновика: адресуется id визита (это ключ строки), 204 без тела.
export function deletePartial(formId: string, visitId: string): Promise<void> {
  return apiRequest(`/forms/${formId}/partials/${visitId}`, { method: 'DELETE' })
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
