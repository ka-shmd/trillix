import { apiRequest } from '../../shared/api/client'
import { visitInsightsSchema, type VisitInsights } from '../../entities/insights'
import { periodRange, type Period } from '../../shared/period'

// Транспорт карточек аналитики: ответ парсится Zod-схемой на границе —
// непровалидированный any внутрь приложения не проходит (web/CLAUDE.md).
export function getVisitInsights(formId: string, period: Period): Promise<VisitInsights> {
  const query = new URLSearchParams(periodRange(period)).toString()
  return apiRequest(`/forms/${formId}/insights${query ? `?${query}` : ''}`, {
    schema: visitInsightsSchema,
  })
}
