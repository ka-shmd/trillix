import { apiRequest } from '../../shared/api/client'
import { visitInsightsSchema, type VisitInsights } from '../../entities/insights'
import { visitsBreakdownSchema, type VisitsBreakdown } from '../../entities/visitsBreakdown'
import { versionStatsSchema, type VersionStat } from '../../entities/versionStats'
import { periodRange, type Period } from '../../shared/period'
import { segmentParams } from '../../shared/segment'

// Транспорт карточек аналитики: ответ парсится Zod-схемой на границе —
// непровалидированный any внутрь приложения не проходит (web/CLAUDE.md).
export function getVisitInsights(
  formId: string,
  period: Period,
  segment?: string,
): Promise<VisitInsights> {
  const query = new URLSearchParams({ ...periodRange(period), ...segmentParams(segment) }).toString()
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

// Разрез по версиям формы за окно (и сегмент, если выбран).
export async function getVersionStats(
  formId: string,
  period: Period,
  segment?: string,
): Promise<VersionStat[]> {
  const query = new URLSearchParams({ ...periodRange(period), ...segmentParams(segment) }).toString()
  const res = await apiRequest(`/forms/${formId}/insights/versions${query ? `?${query}` : ''}`, {
    schema: versionStatsSchema,
  })
  return res.versions
}
