import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { ChevronRight, House } from 'lucide-react'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { WorkspaceSection } from '../../features/workspaces/WorkspaceSection'
import { WorkspaceFormList } from '../../features/forms/WorkspaceFormList'
import { NEW_FORM_SLUG } from '../../features/forms/draft'
import { formKeys } from '../../features/forms/keys'
import { useHeaderSlot } from '../../shared/headerSlot'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// Страница одного пространства (/workspaces/{slug}): та же секция, что на обзоре,
// но одна на весь экран — сюда ведёт клик по пространству в сайдбаре.
//
// Адрес называет пространство SLUG'ом, как адрес формы — form.slug. Само оно
// берётся из СПИСКА (GET /workspaces), а не отдельной ручкой: список
// уже прочитан сайдбаром на каждом экране, и второй запрос ради имени и числа форм
// был бы лишним. Отсюда же и «нет такого»: список отдаёт только те пространства, где
// человек состоит, поэтому чужое и несуществующее здесь неотличимы — как и на сервере.
export const Route = createFileRoute('/_app/workspaces/$workspaceSlug')({
  component: WorkspacePage,
})

function WorkspacePage() {
  const { workspaceSlug } = Route.useParams()
  const workspaces = useQuery(workspacesQueryOptions)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const headerSlot = useHeaderSlot()
  const workspace = workspaces.data?.find((w) => w.slug === workspaceSlug)

  // «+» открывает редактор нового черновика ЭТОГО пространства; самой формы ещё нет —
  // её заводит первая правка (features/forms/draft.ts). Пространство едет в адрес
  // редактора по общему правилу кабинета (пусто = личное).
  function createForm() {
    if (!workspace) return
    void navigate({
      to: '/forms/$slug/edit',
      params: { slug: NEW_FORM_SLUG },
      search: workspace.isPersonal ? {} : { w: workspace.slug },
    })
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      {headerSlot && createPortal(<HeaderCrumbs name={workspace?.name ?? '…'} />, headerSlot)}
      <h1 className="sr-only">{workspace?.name ?? 'Пространство'}</h1>

      {workspaces.isPending && (
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {workspaces.isError && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <p className="mb-3 text-sm">Не удалось загрузить пространство.</p>
          <Button variant="outline" size="sm" onClick={() => workspaces.refetch()}>
            Повторить
          </Button>
        </div>
      )}

      {workspaces.data && !workspace && (
        <div className="rounded-lg border p-6">
          <p className="mb-3 text-sm">Такого пространства нет или доступ к нему закрыт.</p>
          <Button variant="outline" size="sm" asChild>
            <Link to="/workspaces">Ко всем пространствам</Link>
          </Button>
        </div>
      )}

      {workspace && (
        <WorkspaceSection
          workspace={workspace}
          onCreateForm={createForm}
          // Пространства больше нет — уходим на обзор, а страницы его форм
          // выбрасываем из кэша: ключи форм чистит вызывающий, а не мутация.
          onDeleted={() => {
            qc.invalidateQueries({ queryKey: formKeys.list() })
            void navigate({ to: '/workspaces' })
          }}
        >
          <WorkspaceFormList workspaceId={workspace.id} />
        </WorkspaceSection>
      )}
    </div>
  )
}

// Крошки страницы: дом → «Пространства» → имя. Тот же вид, что у крошек редактора
// (BuilderScreen): один верхний бар — один способ назвать текущее место.
function HeaderCrumbs({ name }: { name: string }) {
  return (
    <nav aria-label="Хлебные крошки" className="flex min-w-0 items-center gap-1 text-sm">
      <Link
        to="/forms"
        search={(prev) => prev}
        aria-label="Дом"
        className="flex shrink-0 items-center text-muted-foreground hover:text-foreground"
      >
        <House className="size-4" />
      </Link>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
      <Link to="/workspaces" className="shrink-0 text-muted-foreground hover:text-foreground">
        Пространства
      </Link>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
      <span className="min-w-0 truncate font-medium" aria-current="page">
        {name}
      </span>
    </nav>
  )
}
