import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { WorkspaceSection } from '../../features/workspaces/WorkspaceSection'
import { WorkspaceFormList } from '../../features/forms/WorkspaceFormList'
import { NEW_FORM_SLUG } from '../../features/forms/draft'
import { formKeys } from '../../features/forms/keys'
import { PageCrumbs } from '../../shared/page/headerPortals'
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
export const Route = createFileRoute('/_app/workspaces/$workspaceSlug/')({
  component: WorkspacePage,
})

function WorkspacePage() {
  const { workspaceSlug } = Route.useParams()
  const workspaces = useQuery(workspacesQueryOptions)
  const navigate = useNavigate()
  const qc = useQueryClient()
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
      <PageCrumbs
        items={[
          <Link key="ws" to="/workspaces">
            Пространства
          </Link>,
          workspace?.name ?? '…',
        ]}
      />
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
