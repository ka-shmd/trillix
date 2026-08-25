import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import { NEW_FORM_SLUG } from '../../features/forms/draft'
import { formsListQueryOptions } from '../../features/forms/queries'
import { useCurrentWorkspace } from '../../features/workspaces/current'
import { FormCard } from '../../features/forms/FormCard'
import { FormsToolbar } from '../../features/forms/FormsToolbar'
import { DEFAULT_FORMS_SORT, formsSortSchema, type FormsSort } from '../../entities/form'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// Поиск и сортировка живут в адресной строке, а не в useState: ссылка на
// отфильтрованный дашборд сохраняется в закладки, F5 не сбрасывает, «Назад»
// работает — то же решение, что у табов формы.
//
// Оба параметра НЕОБЯЗАТЕЛЬНЫ, и умолчания в адрес не пишутся. Так «/forms»
// остаётся «/forms» (а не «/forms?q=&sort=updated»), и — главное — десяток
// существующих ссылок на дашборд по всему кабинету не обязан перечислять
// параметры поиска: обязательные search-параметры типы роутера требуют у КАЖДОЙ
// ссылки. Мусор из адреса (его правят руками) гасит catch: неизвестная сортировка
// читается как умолчание, а не роняет экран.
// w — текущее пространство SLUG'ом (пусто = личное), см. shared/currentWorkspace;
// в id его переводит useCurrentWorkspace, потому что запрос списка ждёт id.
const formsSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  sort: formsSortSchema.optional().catch(undefined),
  w: z.string().optional().catch(undefined),
})

// Дашборд форм (/forms): грид карточек с курсорной подгрузкой, поиск, сортировка,
// создание формы.
export const Route = createFileRoute('/_app/forms/')({
  validateSearch: formsSearchSchema,
  component: FormsDashboard,
})

function FormsDashboard() {
  const navigate = useNavigate()
  const { q = '', sort = DEFAULT_FORMS_SORT } = Route.useSearch()
  // В адресе пространство названо SLUG'ом, а список форм спрашивается по id
  // (features/workspaces/current.ts). Пока перевод не сделан, запрос не
  // включается: с пустым workspaceId он показал бы формы ЛИЧНОГО пространства
  // под адресом командного — то есть чужой список без единого признака подмены.
  const workspace = useCurrentWorkspace()
  const query = useInfiniteQuery({
    ...formsListQueryOptions({ q, sort, workspaceId: workspace?.id ?? '' }),
    enabled: workspace !== undefined,
  })

  // Кнопка НИЧЕГО не создаёт: открывает редактор нового черновика, а форму заводит
  // первая правка (features/forms/draft.ts). search сохраняется — из него редактор
  // берёт пространство (?w=), в котором её заводить.
  function handleCreate() {
    void navigate({
      to: '/forms/$slug/edit',
      params: { slug: NEW_FORM_SLUG },
      search: (prev) => prev,
    })
  }

  // replace: правки поиска не должны копиться в истории браузера — иначе «Назад»
  // отматывает набранный запрос по букве вместо возврата на прошлый экран.
  // Значение по умолчанию уходит из адреса (undefined), а не остаётся пустым
  // хвостом «?q=».
  const onSearchChange = useCallback(
    (value: string) => {
      void navigate({
        to: '/forms',
        search: (prev) => ({ ...prev, q: value === '' ? undefined : value }),
        replace: true,
      })
    },
    [navigate],
  )

  const onSortChange = useCallback(
    (value: FormsSort) => {
      void navigate({
        to: '/forms',
        search: (prev) => ({ ...prev, sort: value === DEFAULT_FORMS_SORT ? undefined : value }),
        replace: true,
      })
    },
    [navigate],
  )

  const forms = query.data?.pages.flatMap((p) => p.forms) ?? []
  const isSearching = q.trim() !== ''

  return (
    <section className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Мои формы</h1>
        <Button onClick={handleCreate} className="gap-2">
          <Plus className="size-4" />
          Новая форма
        </Button>
      </div>

      <FormsToolbar
        q={q}
        sort={sort}
        onSearchChange={onSearchChange}
        onSortChange={onSortChange}
      />

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
        // Два разных пустых состояния: «форм нет» и «под запрос ничего не нашлось»
        // — это разные новости, и предлагать создание формы в ответ на неудачный
        // поиск значит подталкивать к дублю той, что просто не нашлась.
        isSearching ? (
          <div className="mx-auto mt-12 max-w-md text-center">
            <h2 className="text-lg font-medium">Ничего не найдено</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              По запросу «{q}» форм нет. Попробуйте другое слово.
            </p>
            <Button variant="outline" onClick={() => onSearchChange('')} className="mt-4">
              Сбросить поиск
            </Button>
          </div>
        ) : (
          <div className="mx-auto mt-12 max-w-md text-center">
            <h2 className="text-lg font-medium">Пока нет ни одной формы</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Создайте первую — она появится здесь.
            </p>
            <Button onClick={handleCreate} className="mt-4 gap-2">
              <Plus className="size-4" />
              Новая форма
            </Button>
          </div>
        )
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
