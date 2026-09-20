import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { submissionKeys } from './keys'
import {
  deletePartial,
  deleteSubmission,
  getSubmission,
  getSubmissionsCount,
  getSummary,
  listBlockAnswers,
  listPartials,
  listSubmissions,
  type SubmissionsKind,
} from './api'
import { ApiError } from '../../shared/api/errors'
import { analyticsFreshness, type Period } from '../../shared/period'

// Ответы формы — серверный стейт с курсорной пагинацией (новые сверху), страницы
// подгружаются через getNextPageParam; курсор непрозрачен для клиента.
export function submissionsListQueryOptions(formId: string, kind: SubmissionsKind) {
  return infiniteQueryOptions({
    queryKey: submissionKeys.list(formId, kind),
    queryFn: ({ pageParam }) => listSubmissions(formId, kind, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
}

// Один ответ по id — окну ответа, открытому не из списка (карточка записи на полотне
// расписания). `enabled` решает вызывающий: до открытия окна ходить незачем.
export function submissionQueryOptions(formId: string, submissionId: string) {
  return queryOptions({
    queryKey: submissionKeys.one(formId, submissionId),
    queryFn: () => getSubmission(formId, submissionId),
  })
}

// Черновики формы — та же курсорная подгрузка, что у ответов (курсор непрозрачен,
// внутри он составной).
//
// Отказ по тарифу (402 plan_required) НЕ ретраится, как и у воронки: это устойчивый
// ответ, а не сбой, и три попытки с бэкоффом задержали бы плашку на секунды —
// экран выглядел бы сломанным.
export function partialsListQueryOptions(formId: string) {
  return infiniteQueryOptions({
    queryKey: submissionKeys.partials(formId),
    queryFn: ({ pageParam }) => listPartials(formId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: (count: number, error: Error) =>
      !(error instanceof ApiError && error.code === 'plan_required') && count < 3,
  })
}

// Сводка формы — обычный запрос (не пагинируется: сервер отдаёт готовый итог).
// Отказ по тарифу (фильтр закрыт) не ретраится: это устойчивый ответ, а не сбой.
export function submissionsSummaryQueryOptions(
  formId: string,
  period: Period,
  where?: string,
  segments?: string[],
) {
  return queryOptions({
    ...analyticsFreshness,
    queryKey: submissionKeys.summary(formId, period, where, segments),
    queryFn: () => getSummary(formId, period, where, segments),
    retry: (count: number, error: Error) =>
      !(error instanceof ApiError && error.code === 'plan_required') && count < 3,
  })
}

// Все значения одного вопроса — курсорная пагинация, как у списка ответов.
// enabled оставлен вызывающему: запрос уходит только при открытом окне, иначе
// каждый вопрос сводки тянул бы свою страницу заранее.
export function blockAnswersQueryOptions(
  formId: string,
  blockId: string,
  period: Period,
  where?: string,
  segments?: string[],
) {
  return infiniteQueryOptions({
    ...analyticsFreshness,
    queryKey: submissionKeys.blockAnswers(formId, period, blockId, where, segments),
    queryFn: ({ pageParam }) => listBlockAnswers(formId, blockId, period, pageParam, where, segments),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
}

// Счётчик ответов за период — карточка над вкладками аналитики.
export function submissionsCountQueryOptions(formId: string, period: Period) {
  return queryOptions({
    ...analyticsFreshness,
    queryKey: submissionKeys.count(formId, period),
    queryFn: () => getSubmissionsCount(formId, period),
  })
}

// Удаление черновика инвалидирует только список черновиков: в сводку, выгрузку и
// счётчик ответов он не входит вовсе — это неотправленное, и считать его вместе с
// ответами значило бы завысить всё сразу.
export function useDeletePartial(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (visitId: string) => deletePartial(formId, visitId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: submissionKeys.partials(formId) })
      // «Все ответы» подмешивают черновики — удалённый обязан исчезнуть и оттуда.
      void qc.invalidateQueries({ queryKey: submissionKeys.listAllKinds(formId) })
    },
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
      void qc.invalidateQueries({ queryKey: submissionKeys.listAllKinds(formId) })
      // По префиксу, без периода: удалённый ответ обязан исчезнуть из всех окон
      // наблюдения, а не только из открытого сейчас.
      void qc.invalidateQueries({ queryKey: submissionKeys.summaryAllPeriods(formId) })
      void qc.invalidateQueries({ queryKey: submissionKeys.countAllPeriods(formId) })
    },
  })
}
