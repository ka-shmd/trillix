import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { FileText, LayoutTemplate, Plus, SearchX } from 'lucide-react'
import { z } from 'zod'
import { NEW_FORM_SLUG } from '../../features/forms/draft'
import { formsListQueryOptions } from '../../features/forms/queries'
import { useCurrentWorkspace } from '../../features/workspaces/current'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { FormRow, FormRowsHeader } from '../../features/forms/FormRow'
import { FormsToolbar } from '../../features/forms/FormsToolbar'
import {
  DEFAULT_FORMS_FILTER,
  DEFAULT_FORMS_SORT,
  formsFilterSchema,
  formsSortSchema,
  type FormsFilter,
  type FormsSort,
} from '../../entities/form'
import { humanError } from '../../shared/api/errors'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'
import { EmptyState, ErrorState } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// Поиск, фильтр и сортировка живут в адресной строке, а не в useState: ссылка на
// отфильтрованный список сохраняется в закладки, F5 не сбрасывает, «Назад»
// работает — то же решение, что у табов формы.
//
// Все параметры НЕОБЯЗАТЕЛЬНЫ, и умолчания в адрес не пишутся. Так «/w/{slug}/forms»
// остаётся собой (а не «…?q=&sort=updated&status=all»), и — главное — десяток
// существующих ссылок на список по всему кабинету не обязан перечислять параметры:
// обязательные search-параметры типы роутера требуют у КАЖДОЙ ссылки. Мусор из
// адреса (его правят руками) гасит catch: неизвестный статус читается как
// умолчание, а не роняет экран.
// w — текущее пространство SLUG'ом (пусто = личное), см. shared/currentWorkspace;
// в id его переводит useCurrentWorkspace, потому что запрос списка ждёт id.
const formsSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  sort: formsSortSchema.optional().catch(undefined),
  status: formsFilterSchema.optional().catch(undefined),
  w: z.string().optional().catch(undefined),
})

// Список форм пространства: строки с курсорной подгрузкой, поиск, фильтр по
// статусу, сортировка, создание формы.
export const Route = createFileRoute('/_app/w/$workspaceSlug/forms/')({
  validateSearch: formsSearchSchema,
  component: FormsDashboard,
})

function FormsDashboard() {
  const navigate = useNavigate()
  const { workspaceSlug } = Route.useParams()
  const { q = '', sort = DEFAULT_FORMS_SORT, status = DEFAULT_FORMS_FILTER } = Route.useSearch()
  // В адресе пространство названо SLUG'ом, а список форм спрашивается по id
  // (features/workspaces/current.ts). Пока перевод не сделан, запрос не
  // включается: с пустым workspaceId он показал бы формы ЛИЧНОГО пространства
  // под адресом командного — то есть чужой список без единого признака подмены.
  const workspace = useCurrentWorkspace()
  // Список пространств спрашивается ради ОДНОГО ответа: приехал он или нет.
  // Пространство, названное путём и не найденное в нём, — чужое или удалённое, и
  // отличить это состояние от «ещё грузится» иначе нечем (запрос форм при
  // `workspace === undefined` выключен и остаётся `pending` навсегда).
  const workspaces = useQuery(workspacesQueryOptions)
  const query = useInfiniteQuery({
    ...formsListQueryOptions({ q, sort, status, workspaceId: workspace?.id ?? '' }),
    enabled: workspace !== undefined,
  })

  // Кнопка НИЧЕГО не создаёт: открывает редактор нового черновика, а форму заводит
  // первая правка (features/forms/draft.ts). search сохраняется — из него редактор
  // берёт пространство (?w=), в котором её заводить.
  function handleCreate() {
    void navigate({
      to: '/w/$workspaceSlug/forms/$slug/edit',
      params: { workspaceSlug, slug: NEW_FORM_SLUG },
    })
  }

  // replace: правки поиска не должны копиться в истории браузера — иначе «Назад»
  // отматывает набранный запрос по букве вместо возврата на прошлый экран.
  // Значение по умолчанию уходит из адреса (undefined), а не остаётся пустым
  // хвостом «?q=».
  const onSearchChange = useCallback(
    (value: string) => {
      void navigate({
        to: '/w/$workspaceSlug/forms',
        params: { workspaceSlug },
        search: (prev) => ({ ...prev, q: value === '' ? undefined : value }),
        replace: true,
      })
    },
    [navigate, workspaceSlug],
  )

  const onSortChange = useCallback(
    (value: FormsSort) => {
      void navigate({
        to: '/w/$workspaceSlug/forms',
        params: { workspaceSlug },
        search: (prev) => ({ ...prev, sort: value === DEFAULT_FORMS_SORT ? undefined : value }),
        replace: true,
      })
    },
    [navigate, workspaceSlug],
  )

  const onFilterChange = useCallback(
    (value: FormsFilter) => {
      void navigate({
        to: '/w/$workspaceSlug/forms',
        params: { workspaceSlug },
        search: (prev) => ({ ...prev, status: value === DEFAULT_FORMS_FILTER ? undefined : value }),
        replace: true,
      })
    },
    [navigate, workspaceSlug],
  )

  // Сброс сужения — одной кнопкой на оба параметра: под пустой выдачей человек не
  // разбирается, что именно её сузило, поиск или фильтр.
  const resetNarrowing = useCallback(() => {
    void navigate({
      to: '/w/$workspaceSlug/forms',
      params: { workspaceSlug },
      search: (prev) => ({ ...prev, q: undefined, status: undefined }),
      replace: true,
    })
  }, [navigate, workspaceSlug])

  const forms = query.data?.pages.flatMap((p) => p.forms) ?? []
  const isNarrowed = q.trim() !== '' || status !== DEFAULT_FORMS_FILTER

  // Колонка у всех разделов пространства ОДНА, и это то же решение, что у табов
  // формы (владелец, 2026-08-29): переключение раздела не должно двигать левый край
  // содержимого.
  return (
    <PageContainer>
      {/* Путь кончается на самом пространстве: этот экран и есть его корень. */}
      <PageCrumbs items={[workspace?.name ?? '…']} />
      {/* Заголовок — ИМЯ ПРОСТРАНСТВА, а не «Мои формы»: тот же экран показывает
          формы команды, и «мои» там было прямой неправдой. Крошка и заголовок
          называют одно место одним словом. */}
      <PageHeader
        title={workspace?.name ?? '…'}
        actions={
          <>
            {/* Шаблон — способ начать форму, а не место в навигации: пункт сайдбара
                вёл в галерею, не зная пространства, и форма из неё всегда ложилась в
                личное. Здесь пространство названо адресом экрана. */}
            <Button asChild variant="outline">
              <Link to="/w/$workspaceSlug/templates" params={{ workspaceSlug }}>
                <LayoutTemplate className="size-4" />
                Начать с шаблона
              </Link>
            </Button>
            <Button onClick={handleCreate}>
              <Plus className="size-4" />
              Новая форма
            </Button>
          </>
        }
      />

      <div className="mt-8">
        <FormsToolbar
          q={q}
          sort={sort}
          filter={status}
          onSearchChange={onSearchChange}
          onSortChange={onSortChange}
          onFilterChange={onFilterChange}
        />
      </div>

      {workspaces.data && !workspace ? (
        <EmptyState
          title="Такого пространства нет"
          description="Оно удалено или доступ к нему закрыт."
        />
      ) : query.isPending ? (
        <FormsSkeleton />
      ) : query.isError ? (
        <ErrorState
          title={humanError(query.error, 'Не удалось загрузить формы.')}
          onRetry={() => void query.refetch()}
          retryLabel="Повторить"
        />
      ) : forms.length === 0 ? (
        // Два разных пустых состояния: «форм нет» и «под запрос ничего не нашлось»
        // — это разные новости, и предлагать создание формы в ответ на неудачный
        // поиск значит подталкивать к дублю той, что просто не нашлась.
        isNarrowed ? (
          <EmptyState
            icon={SearchX}
            title="Ничего не нашлось"
            description="Под этот поиск и фильтр форм нет. Попробуйте другое слово или снимите фильтр."
            action={
              <Button variant="outline" onClick={resetNarrowing}>
                Сбросить поиск и фильтр
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={FileText}
            title="Пока нет ни одной формы"
            description="Создайте первую — она появится здесь."
            action={
              <Button onClick={handleCreate}>
                <Plus className="size-4" />
                Новая форма
              </Button>
            }
          />
        )
      ) : (
        <>
          <FormRowsHeader />
          <div className="divide-y divide-border">
            {forms.map((form) => (
              <FormRow key={form.id} form={form} workspaceSlug={workspaceSlug} />
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
    </PageContainer>
  )
}

// Скелет на время первой загрузки — экран не мигает пустотой. Форма скелета
// повторяет форму данных: прямоугольники размером с карточку на месте строк
// читались бы как другой экран, который потом «схлопнулся».
function FormsSkeleton() {
  return (
    <div className="flex flex-col gap-px" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-12 rounded-md" />
      ))}
    </div>
  )
}
