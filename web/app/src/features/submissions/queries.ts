import { infiniteQueryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { submissionKeys } from './keys'
import { deleteSubmission, listSubmissions } from './api'

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

// Удаление ответа инвалидирует список ответов формы (total и строки пересчитаются).
// Счётчик на карточке дашборда (formsList) не трогаем отсюда — межфичевый импорт
// ключей запрещён (web/CLAUDE.md); дашборд перечитает список при возврате (remount).
export function useDeleteSubmission(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (submissionId: string) => deleteSubmission(formId, submissionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: submissionKeys.list(formId) }),
  })
}
