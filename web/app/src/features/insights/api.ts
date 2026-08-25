import { apiRequest } from '../../shared/api/client'
import { visitInsightsSchema, type VisitInsights } from '../../entities/insights'
import { visitsBreakdownSchema, type VisitsBreakdown } from '../../entities/visitsBreakdown'
import { periodRange, type Period } from '../../shared/period'

// Транспорт карточек аналитики: ответ парсится Zod-схемой на границе —
// непровалидированный any внутрь приложения не проходит (web/CLAUDE.md).
export function getVisitInsights(formId: string, period: Period): Promise<VisitInsights> {
  const query = new URLSearchParams(periodRange(period)).toString()
  return apiRequest(`/forms/${formId}/insights${query ? `?${query}` : ''}`, {
    schema: visitInsightsSchema,
  })
}

// Вкладка «Визиты» одним запросом: ряд по времени, источники, устройства, браузеры,
// ОС. Одна ручка, а не четыре: все четыре разбивки считаются по одному окну
// наблюдения, и четыре запроса означали бы четыре разных «сейчас».
export function getVisitsBreakdown(formId: string, period: Period): Promise<VisitsBreakdown> {
  const query = new URLSearchParams(periodRange(period)).toString()
  return apiRequest(`/forms/${formId}/insights/visits${query ? `?${query}` : ''}`, {
    schema: visitsBreakdownSchema,
  })
}
