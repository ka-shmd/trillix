import { apiRequest } from '../../shared/api/client'
import { visitInsightsSchema, type VisitInsights } from '../../entities/insights'
import { visitsBreakdownSchema, type VisitsBreakdown } from '../../entities/visitsBreakdown'
import { crosstabSchema, type Crosstab } from '../../entities/summary'
import { versionStatsSchema, type VersionStat } from '../../entities/versionStats'
import { periodRange, type Period } from '../../shared/period'
import { appendSegments } from '../../shared/segment'

// Транспорт карточек аналитики: ответ парсится Zod-схемой на границе —
// непровалидированный any внутрь приложения не проходит (web/CLAUDE.md).
export function getVisitInsights(
  formId: string,
  period: Period,
  segments?: string[],
): Promise<VisitInsights> {
  const query = appendSegments(new URLSearchParams(periodRange(period)), segments).toString()
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
  segments?: string[],
): Promise<VersionStat[]> {
  const query = appendSegments(new URLSearchParams(periodRange(period)), segments).toString()
  const res = await apiRequest(`/forms/${formId}/insights/versions${query ? `?${query}` : ''}`, {
    schema: versionStatsSchema,
  })
  return res.versions
}

// Таблица сопряжённости: вопрос rows × вопрос cols, с окном и фильтром сводки.
export function getCrosstab(
  formId: string,
  period: Period,
  rows: string,
  cols: string,
  where?: string,
  segments?: string[],
): Promise<Crosstab> {
  const params = new URLSearchParams({ ...periodRange(period), rows, cols })
  if (where) params.set('where', where)
  const query = appendSegments(params, segments)
  return apiRequest(`/forms/${formId}/submissions/crosstab?${query.toString()}`, { schema: crosstabSchema })
}
