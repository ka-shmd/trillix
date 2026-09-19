import { queryOptions } from '@tanstack/react-query'

import { insightsKeys } from './keys'
import { ApiError } from '../../shared/api/errors'
import { getVersionStats, getVisitInsights, getVisitsBreakdown } from './api'
import { analyticsFreshness, type Period } from '../../shared/period'

// Карточки аналитики — обычный запрос: сервер отдаёт готовые счётчики.
export function visitInsightsQueryOptions(formId: string, period: Period, segment?: string) {
  return queryOptions({
    ...analyticsFreshness,
    queryKey: insightsKeys.visits(formId, period, segment),
    queryFn: () => getVisitInsights(formId, period, segment),
  })
}

// Разрез по версиям формы. Отказ по тарифу (сегмент закрыт) не ретраится — это
// устойчивый ответ, а не сбой.
export function versionStatsQueryOptions(formId: string, period: Period, segment?: string) {
  return queryOptions({
    ...analyticsFreshness,
    queryKey: insightsKeys.versions(formId, period, segment),
    queryFn: () => getVersionStats(formId, period, segment),
    retry: (count: number, error: Error) =>
      !(error instanceof ApiError && error.code === 'plan_required') && count < 3,
  })
}

// Разбивки вкладки «Визиты» — тоже готовый итог с сервера.
export function visitsBreakdownQueryOptions(formId: string, period: Period) {
  return queryOptions({
    ...analyticsFreshness,
    queryKey: insightsKeys.breakdown(formId, period),
    queryFn: () => getVisitsBreakdown(formId, period),
  })
}
