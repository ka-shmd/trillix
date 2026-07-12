import { infiniteQueryOptions } from '@tanstack/react-query'
import { submissionKeys } from './keys'
import { listSubmissions } from './api'

// Ответы формы — серверный стейт с курсорной пагинацией (новые сверху), страницы
// подгружаются через getNextPageParam; курсор непрозрачен для клиента.
export function submissionsListQueryOptions(formId: string) {
  return infiniteQueryOptions({
    queryKey: submissionKeys.list(formId),
    queryFn: ({ pageParam }) => listSubmissions(formId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
}
