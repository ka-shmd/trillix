import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { meQueryOptions } from '../../features/auth/queries'
import { MembersView } from '../../features/workspaces/MembersView'
import { useCurrentWorkspace } from '../../features/workspaces/current'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { ErrorState, LoadingRows } from '../../shared/page/states'

// Участники пространства (/w/{slug}/members) — раздел пространства, как формы и
// расписания. До этого состав жил окном за кластером кружков и пунктом «…»,
// то есть находился только теми, кто уже знал, где искать.
export const Route = createFileRoute('/_app/w/$workspaceSlug/members')({
  component: MembersPage,
})

function MembersPage() {
  const navigate = useNavigate()
  const workspace = useCurrentWorkspace()
  const workspaceCrumb = useWorkspaceCrumb()
  // Ради одного ответа: приехал список или нет. Пространство, названное путём и не
  // найденное, — чужое или удалённое, и отличить это от «ещё грузится» иначе нечем.
  const workspaces = useQuery(workspacesQueryOptions)
  // Свой профиль — ради одного факта: которая строка списка «я». Спрашивается
  // здесь, а не внутри вида: профиль принадлежит фиче auth, а импорт фичи из
  // фичи запрещён (web/CLAUDE.md). Запрос уже сделан оболочкой кабинета —
  // ключ тот же, лишнего круга не будет.
  const me = useQuery(meQueryOptions)

  return (
    <PageContainer>
      <PageCrumbs items={[workspaceCrumb, 'Участники']} />
      {workspaces.isPending && <LoadingRows rows={3} />}
      {workspaces.isError && (
        <ErrorState
          title="Не удалось загрузить пространство."
          onRetry={() => void workspaces.refetch()}
          retryLabel="Повторить"
        />
      )}
      {workspaces.data && !workspace && (
        <ErrorState
          title="Такого пространства нет или доступ к нему закрыт."
          description="Список пространств отдаёт только те, где вы состоите."
        />
      )}
      {workspace && (
        <MembersView
          workspace={workspace}
          currentUserId={me.data?.id}
          onLeft={() => void navigate({ to: '/workspaces' })}
        />
      )}
    </PageContainer>
  )
}
