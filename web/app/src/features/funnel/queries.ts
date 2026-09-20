import { queryOptions } from '@tanstack/react-query'

import { funnelKeys } from './keys'
import { getFunnel } from './api'
import { ApiError } from '../../shared/api/errors'
import { analyticsFreshness, type Period } from '../../shared/period'

// Воронка формы — обычный запрос: сервер отдаёт готовый итог (счётчики по шагам),
// пагинировать нечего.
//
// Отказ по тарифу (402 plan_required) НЕ ретраится: это не сбой, а устойчивый
// ответ, и три попытки с бэкоффом означали бы, что плашка «откройте Pro»
// появляется через несколько секунд ожидания — выглядит как поломка.
export function funnelQueryOptions(formId: string, period: Period, segments?: string[]) {
  return queryOptions({
    ...analyticsFreshness,
    queryKey: funnelKeys.detail(formId, period, segments),
    queryFn: () => getFunnel(formId, period, segments),
    retry: (count: number, error: Error) =>
      !(error instanceof ApiError && error.code === 'plan_required') && count < 3,
  })
}
