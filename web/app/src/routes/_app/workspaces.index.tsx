import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { SquarePlus } from 'lucide-react'

import { workspacesQueryOptions } from '../../features/workspaces/queries'
import { CreateWorkspaceDialog } from '../../features/workspaces/CreateWorkspaceDialog'
import { WorkspaceRow } from '../../features/workspaces/WorkspaceRow'
import { formKeys } from '../../features/forms/keys'
import { PageActions, PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'
import { ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'

// Все пространства (/workspaces) — единственный экран, отвечающий на вопрос «какие
// у меня вообще пространства». Формы под каждым он больше не показывает: тот же
// список, в другом виде и по другому адресу, показывал экран самого пространства.
// Здесь остались действия НАД пространством: завести, переименовать, удалить.
export const Route = createFileRoute('/_app/workspaces/')({
  component: WorkspacesPage,
})

function WorkspacesPage() {
  const workspaces = useQuery(workspacesQueryOptions)
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)

  return (
    <PageContainer>
      <PageCrumbs items={['Пространства']} />
      <PageActions>
        <Button variant="ghost" size="sm" className="gap-2" onClick={() => setCreating(true)}>
          {/* Квадрат с плюсом — «завести пространство»; голый Plus в кабинете уже
              занят смыслом «новая форма». */}
          <SquarePlus className="size-4" />
          Новое пространство
        </Button>
      </PageActions>

      <PageHeader
        title="Пространства"
        description="Формы, расписания и участники принадлежат пространству. Личное есть у каждого, командные заводите под общую работу."
      />

      <div className="mt-8 flex flex-col gap-2">
        {workspaces.isPending && <LoadingRows rows={2} />}
        {workspaces.isError && (
          <ErrorState
            title="Не удалось загрузить пространства."
            onRetry={() => void workspaces.refetch()}
            retryLabel="Повторить"
          />
        )}
        {workspaces.data?.map((ws) => (
          <WorkspaceRow
            key={ws.id}
            workspace={ws}
            // Формы удалённого ушли вместе с ним; их страницы остались бы в кэше и
            // всплыли бы по прямой ссылке. Ключи форм — чужая фича, поэтому чистка
            // живёт здесь, а не в мутации.
            onDeleted={() => qc.invalidateQueries({ queryKey: formKeys.list() })}
          />
        ))}
      </div>

      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </PageContainer>
  )
}
