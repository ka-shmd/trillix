import { queryOptions } from '@tanstack/react-query'

import { insightsKeys } from './keys'
import { getVisitInsights, getVisitsBreakdown } from './api'
import { analyticsFreshness, type Period } from '../../shared/period'

// Карточки аналитики — обычный запрос: сервер отдаёт готовые счётчики.
export function visitInsightsQueryOptions(formId: string, period: Period) {
  return queryOptions({
    ...analyticsFreshness,
    queryKey: insightsKeys.visits(formId, period),
    queryFn: () => getVisitInsights(formId, period),
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
