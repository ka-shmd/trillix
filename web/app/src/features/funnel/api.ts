import { apiRequest } from '../../shared/api/client'
import { formFunnelSchema, type FormFunnel } from '../../entities/funnel'
import { periodRange, type Period } from '../../shared/period'
import { segmentParams } from '../../shared/segment'

// Транспорт воронки: ответ парсится Zod-схемой на границе — непровалидированный any
// внутрь приложения не проходит (web/CLAUDE.md).
export function getFunnel(formId: string, period: Period, segment?: string): Promise<FormFunnel> {
  const query = new URLSearchParams({ ...periodRange(period), ...segmentParams(segment) }).toString()
  return apiRequest(`/forms/${formId}/funnel${query ? `?${query}` : ''}`, { schema: formFunnelSchema })
}
