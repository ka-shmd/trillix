import { queryOptions } from '@tanstack/react-query'

import { insightsKeys } from './keys'
import { getVisitInsights } from './api'
import { type Period } from '../../shared/period'

// Карточки аналитики — обычный запрос: сервер отдаёт готовые счётчики.
export function visitInsightsQueryOptions(formId: string, period: Period) {
  return queryOptions({
    queryKey: insightsKeys.visits(formId, period),
    queryFn: () => getVisitInsights(formId, period),
  })
}
