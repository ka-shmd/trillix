import { infiniteQueryOptions, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { submissionKeys } from './keys'
import { deleteSubmission, getSubmissionsCount, getSummary, listSubmissions } from './api'
import { type Period } from '../../shared/period'

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

// Сводка формы — обычный запрос (не пагинируется: сервер отдаёт готовый итог).
export function submissionsSummaryQueryOptions(formId: string, period: Period) {
  return queryOptions({
    queryKey: submissionKeys.summary(formId, period),
    queryFn: () => getSummary(formId, period),
  })
}

// Счётчик ответов за период — карточка над вкладками аналитики.
export function submissionsCountQueryOptions(formId: string, period: Period) {
  return queryOptions({
    queryKey: submissionKeys.count(formId, period),
    queryFn: () => getSubmissionsCount(formId, period),
  })
}

// Удаление ответа инвалидирует список ответов формы (total и строки пересчитаются) и
// сводку: удалённый ответ обязан исчезнуть из распределений, иначе таблица и сводка
// расходятся на глазах у владельца.
// Счётчик на карточке дашборда (formsList) не трогаем отсюда — межфичевый импорт
// ключей запрещён (web/CLAUDE.md); дашборд перечитает список при возврате (remount).
export function useDeleteSubmission(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (submissionId: string) => deleteSubmission(formId, submissionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: submissionKeys.list(formId) })
      // По префиксу, без периода: удалённый ответ обязан исчезнуть из всех окон
      // наблюдения, а не только из открытого сейчас.
      void qc.invalidateQueries({ queryKey: submissionKeys.summaryAllPeriods(formId) })
      void qc.invalidateQueries({ queryKey: submissionKeys.countAllPeriods(formId) })
    },
  })
}
