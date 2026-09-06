import { useInfiniteQuery } from '@tanstack/react-query'
import { DEFAULT_FORMS_SORT } from '../../entities/form'
import { ApiError } from '../../shared/api/errors'
import { FormRow } from './FormRow'
import { formsListQueryOptions } from './queries'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// Сколько форм видно под пространством сразу; «Показать ещё» просит следующую
// такую же страницу (решение владельца 2026-08-22). Обзор показывает ВСЕ
// пространства разом, поэтому длина каждого списка — общий бюджет экрана, а не
// частное дело одного пространства.
const FORMS_PER_WORKSPACE = 10

// WorkspaceFormList — формы одного пространства плоским списком: тело секции в
// обзоре пространств (/workspaces).
//
// Живёт в фиче ФОРМ, а не пространств, хотя рисуется внутри секции пространства:
// снаружи ему нужен только id, а внутри — ключи, запросы и строки форм. Секция
// принимает его детьми (импорт фичи из фичи запрещён, web/CLAUDE.md).
export function WorkspaceFormList({
  workspaceId,
  workspaceSlug,
}: {
  workspaceId: string
  // slug того же пространства: строке формы он нужен для ссылки в редактор, которая
  // адресуется через пространство (см. FormCard). Оба поля берутся из одного объекта
  // списка — переводить одно в другое здесь не из чего.
  workspaceSlug: string
}) {
  const query = useInfiniteQuery(
    formsListQueryOptions({
      q: '',
      sort: DEFAULT_FORMS_SORT,
      workspaceId,
      limit: FORMS_PER_WORKSPACE,
    }),
  )
  const forms = query.data?.pages.flatMap((p) => p.forms) ?? []

  if (query.isPending) {
    return (
      <div className="space-y-1 py-1" aria-hidden="true">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }

  if (query.isError) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <p className="mb-3 text-sm">{formsErrorText(query.error)}</p>
        <Button variant="outline" size="sm" onClick={() => query.refetch()}>
          Повторить
        </Button>
      </div>
    )
  }

  if (forms.length === 0) {
    return <p className="px-3 py-2 text-sm text-muted-foreground">Пока нет форм.</p>
  }

  return (
    <>
      <ul className="space-y-1.5">
        {forms.map((form) => (
          <FormRow key={form.id} form={form} workspaceSlug={workspaceSlug} />
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="ml-1 mt-1 text-muted-foreground"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
        </Button>
      )}
    </>
  )
}

// Замороженное даунгрейдом пространство отдаёт 403 на свои формы. Это не поломка:
// формы целы, доступ вернётся вместе с тарифом — и сказать это надо словами,
// а не «не удалось загрузить».
function formsErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === 'workspace_frozen') {
    return 'Доступ к формам закрыт: тариф больше не покрывает столько пространств или участников. Формы и ответы целы — доступ вернётся вместе с тарифом.'
  }
  return 'Не удалось загрузить формы пространства.'
}
