import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LogOut } from 'lucide-react'

import type { Workspace } from '../../entities/workspace'
import { humanError } from '../../shared/api/errors'
import { PageHeader } from '../../shared/page/PageHeader'
import { Section } from '../../shared/page/Section'
import { ErrorState, LoadingRows } from '../../shared/page/states'
import { usePlanQuota } from '../plan/useFeature'
import { JoinLinkSection } from './JoinLinkSection'
import { MemberRow } from './MemberRow'
import { membersQueryOptions, useLeaveWorkspace } from './queries'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// Состав пространства и приглашения — СТРАНИЦА (`/w/{slug}/members`), а не окно.
// Окном это было потому, что участники не были разделом: попасть к ним можно было
// только кластером кружков или пунктом «…», то есть найти их можно было лишь зная,
// где искать (спека `docs/design/cabinet-navigation.md` §2).
//
// Кнопки рисуются по `permissions` с сервера — матрица прав живёт там в одном месте
// и в TypeScript не дублируется: спрашиваем действие, а не роль.
export function MembersView({
  workspace,
  currentUserId,
  onLeft,
}: {
  workspace: Workspace
  // currentUserId — чтобы пометить в списке свою строку. Приезжает пропом из
  // маршрута, а не запросом отсюда: профиль — предмет фичи auth, а импорт фичи
  // из фичи запрещён (web/CLAUDE.md).
  currentUserId: string | undefined
  // onLeft — куда уходить, покинув пространство: его страницы больше нет, и
  // остаться на ней нельзя. Переход задаёт маршрут.
  onLeft: () => void
}) {
  const state = useQuery(membersQueryOptions(workspace.id))
  const can = (action: string) => state.data?.permissions.includes(action) ?? false
  const canManage = can('member.manage')

  // Снимок тарифа спрашивается ТОЛЬКО у того, кому это право дано: ручка стоит за
  // `billing.view`, и редактору она отвечает 403. Право спрашивается по действию, а
  // не по роли, поэтому здесь именно billing.view, а не «раз он владелец».
  const quota = usePlanQuota('members_per_workspace', { enabled: can('billing.view') })
  // Места показываются, ТОЛЬКО когда у них есть потолок. `undefined` от usePlanQuota —
  // «пока не знаю» (снимок едет или не приехал), `limit: null` — безлимит: в первом
  // случае «0 из 0» пугало бы сильнее пустого места, во втором «3 из ∞» не число.
  // Оба сводятся к одному состоянию — счётчика нет.
  const seats =
    quota !== undefined && quota.limit !== null
      ? { used: quota.used, limit: quota.limit }
      : undefined

  const header = (
    <PageHeader
      title="Участники"
      description="Формы, ответы и расписания пространства видны всем, кто в нём состоит."
      meta={
        state.data && (
          <>
            <Badge variant="secondary">
              {state.data.members.length} {pluralMembers(state.data.members.length)}
            </Badge>
            {seats && (
              <Badge variant={seats.used >= seats.limit ? 'destructive' : 'outline'}>
                {seats.used} из {seats.limit} мест
              </Badge>
            )}
          </>
        )
      }
    />
  )

  if (state.isPending) {
    return (
      <div className="flex flex-col gap-12">
        {header}
        <LoadingRows rows={3} />
      </div>
    )
  }
  if (state.isError) {
    return (
      <div className="flex flex-col gap-12">
        {header}
        <ErrorState
          title={humanError(state.error, 'Не удалось загрузить участников.')}
          onRetry={() => void state.refetch()}
          retryLabel="Повторить"
        />
      </div>
    )
  }
  if (!state.data) return null

  return (
    <div className="flex flex-col gap-12">
      {header}

      <Section title="В пространстве">
        <ul className="divide-y border-t">
          {state.data.members.map((m) => (
            <MemberRow
              key={m.userId}
              workspaceId={workspace.id}
              member={m}
              isMe={m.userId === currentUserId}
              canManage={canManage}
              canTransfer={can('ownership.transfer')}
            />
          ))}
        </ul>
      </Section>

      {canManage && <JoinLinkSection workspaceId={workspace.id} />}

      {/* Личное пространство не покидают: оно и есть пространство самого человека.
          Владелец тоже не может — сначала передать владение или удалить
          пространство, и именно поэтому кнопки у него здесь нет. */}
      {!workspace.isPersonal && !canManage && (
        <Section
          title="Выход"
          description="Формы и ответы останутся в пространстве — доступ к ним потеряете только вы."
        >
          <LeaveButton workspace={workspace} onLeft={onLeft} />
        </Section>
      )}

    </div>
  )
}

// Выход из пространства спрашивает подтверждение: доступ к чужим формам и ответам
// назад сам не возвращается — нужно новое приглашение, а выписать его может
// только владелец (DESIGN-SYSTEM §7, «подтверждение опасного — AlertDialog»).
function LeaveButton({ workspace, onLeft }: { workspace: Workspace; onLeft: () => void }) {
  const [open, setOpen] = useState(false)
  const leave = useLeaveWorkspace(workspace.id)

  return (
    <>
      <Button variant="outline" className="self-start" onClick={() => setOpen(true)}>
        <LogOut className="size-4" />
        Покинуть пространство
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Покинуть «{workspace.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Формы, ответы и расписания останутся в пространстве — доступ к ним потеряете только
              вы. Вернуться можно будет лишь по новому приглашению от владельца.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {leave.isError && (
            <p role="alert" className="text-sm text-destructive">
              {humanError(leave.error, 'Не удалось выйти. Попробуйте ещё раз.')}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={leave.isPending}
              onClick={(e) => {
                e.preventDefault()
                leave.mutate(undefined, { onSuccess: onLeft })
              }}
            >
              {leave.isPending ? 'Выходим…' : 'Покинуть'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// Склонение «участник» по числу: 1 участник, 2 участника, 5 участников. Живёт
// здесь, а не в shared/format: shared держит склонения, нужные нескольким фичам
// (ответы, просмотры, люди), а это слово сегодня произносит один экран.
function pluralMembers(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'участник'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'участника'
  return 'участников'
}
