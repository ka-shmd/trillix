import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { formsListQueryOptions, useCreateForm } from '../../features/forms/queries'
import { FormCard } from '../../features/forms/FormCard'

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
    <section className="forms-page">
      <div className="forms-header">
        <h1>Мои формы</h1>
        <button type="button" className="primary" onClick={handleCreate} disabled={create.isPending}>
          {create.isPending ? 'Создаём…' : 'Новая форма'}
        </button>
      </div>

      {query.isPending ? (
        <FormsSkeleton />
      ) : query.isError ? (
        <div className="forms-error" role="alert">
          <p>Не удалось загрузить формы.</p>
          <button type="button" onClick={() => query.refetch()}>
            Повторить
          </button>
        </div>
      ) : forms.length === 0 ? (
        <div className="empty-state">
          <h2>Пока нет ни одной формы</h2>
          <p>Создайте первую — она появится здесь.</p>
        </div>
      ) : (
        <>
          <div className="forms-grid">
            {forms.map((form) => (
              <FormCard key={form.id} form={form} />
            ))}
          </div>
          {query.hasNextPage && (
            <div className="forms-more">
              <button
                type="button"
                onClick={() => query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
              </button>
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
    <div className="forms-grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="form-card form-card-skeleton" />
      ))}
    </div>
  )
}
