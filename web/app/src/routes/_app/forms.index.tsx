import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { formsListQueryOptions, useCreateForm } from '../../features/forms/queries'
import { FormCard } from '../../features/forms/FormCard'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// Дашборд форм (/forms): грид карточек с курсорной подгрузкой, создание формы.
export const Route = createFileRoute('/_app/forms/')({
  component: FormsDashboard,
})

function FormsDashboard() {
  const navigate = useNavigate()
  const create = useCreateForm()
  const query = useInfiniteQuery(formsListQueryOptions)

  function handleCreate() {
    create.mutate(undefined, {
      onSuccess: (form) => navigate({ to: '/forms/$formId/edit', params: { formId: form.id } }),
    })
  }

  const forms = query.data?.pages.flatMap((p) => p.forms) ?? []

  return (
    <section className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Мои формы</h1>
        <Button onClick={handleCreate} disabled={create.isPending} className="gap-2">
          <Plus className="size-4" />
          {create.isPending ? 'Создаём…' : 'Новая форма'}
        </Button>
      </div>

      {query.isPending ? (
        <FormsSkeleton />
      ) : query.isError ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <p className="mb-3 text-sm">Не удалось загрузить формы.</p>
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            Повторить
          </Button>
        </div>
      ) : forms.length === 0 ? (
        <div className="mx-auto mt-12 max-w-md text-center">
          <h2 className="text-lg font-medium">Пока нет ни одной формы</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Создайте первую — она появится здесь.
          </p>
          <Button onClick={handleCreate} disabled={create.isPending} className="mt-4 gap-2">
            <Plus className="size-4" />
            Новая форма
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
            {forms.map((form) => (
              <FormCard key={form.id} form={form} />
            ))}
          </div>
          {query.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button
                variant="outline"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

// Скелетоны на время первой загрузки — экран не мигает пустотой.
function FormsSkeleton() {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4"
      aria-hidden="true"
    >
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-36 rounded-xl" />
      ))}
    </div>
  )
}
