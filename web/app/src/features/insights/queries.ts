import { queryOptions } from '@tanstack/react-query'

import { insightsKeys } from './keys'
import { ApiError } from '../../shared/api/errors'
import { getCrosstab, getVersionStats, getVisitInsights, getVisitsBreakdown } from './api'
import { analyticsFreshness, type Period } from '../../shared/period'

// Карточки аналитики — обычный запрос: сервер отдаёт готовые счётчики. Отказ по
// тарифу не ретраится: с сегментом ручка гейтится так же, как воронка, а 402 —
// устойчивый ответ, а не сбой.
export function visitInsightsQueryOptions(formId: string, period: Period, segment?: string) {
  return queryOptions({
    ...analyticsFreshness,
    queryKey: insightsKeys.visits(formId, period, segment),
    queryFn: () => getVisitInsights(formId, period, segment),
    retry: (count: number, error: Error) =>
      !(error instanceof ApiError && error.code === 'plan_required') && count < 3,
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

export function crosstabQueryOptions(
  formId: string,
  period: Period,
  rows: string,
  cols: string,
  where?: string,
  segment?: string,
) {
  return queryOptions({
    ...analyticsFreshness,
    queryKey: insightsKeys.crosstab(formId, period, rows, cols, where, segment),
    queryFn: () => getCrosstab(formId, period, rows, cols, where, segment),
    retry: (count: number, error: Error) =>
      !(error instanceof ApiError && error.code === 'plan_required') && count < 3,
  })
}
