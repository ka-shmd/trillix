import { queryOptions } from '@tanstack/react-query'

import { funnelKeys } from './keys'
import { getFunnel } from './api'

// Воронка формы — обычный запрос: сервер отдаёт готовый итог (счётчики по шагам),
// пагинировать нечего.
export function funnelQueryOptions(formId: string) {
  return queryOptions({
    queryKey: funnelKeys.detail(formId),
    queryFn: () => getFunnel(formId),
  })
}
