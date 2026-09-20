import { apiRequest } from '../../shared/api/client'
import { formFunnelSchema, type FormFunnel } from '../../entities/funnel'
import { periodRange, type Period } from '../../shared/period'
import { appendSegments } from '../../shared/segment'

// Транспорт воронки: ответ парсится Zod-схемой на границе — непровалидированный any
// внутрь приложения не проходит (web/CLAUDE.md).
export function getFunnel(formId: string, period: Period, segments?: string[]): Promise<FormFunnel> {
  const query = appendSegments(new URLSearchParams(periodRange(period)), segments).toString()
  return apiRequest(`/forms/${formId}/funnel${query ? `?${query}` : ''}`, { schema: formFunnelSchema })
}
