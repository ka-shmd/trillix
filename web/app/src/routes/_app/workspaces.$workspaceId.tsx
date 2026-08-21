import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ArrowLeft, LogOut, Mail, UserPlus, X } from 'lucide-react'
import {
  membersQueryOptions,
  useInviteMember,
  useLeaveWorkspace,
  useRemoveMember,
  workspacesQueryOptions,
} from '../../features/workspaces/queries'
import { ApiError } from '../../shared/api/errors'
import { UserAvatar } from '../../shared/UserAvatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

// Участники пространства (/workspaces/{id}): состав, приглашения, снятие
// доступа. Кнопки рисуются по permissions с сервера — матрица прав живёт там
// в одном месте и в TypeScript не дублируется.
export const Route = createFileRoute('/_app/workspaces/$workspaceId')({
  component: MembersPage,
})

function MembersPage() {
  const { workspaceId } = Route.useParams()
  const navigate = Route.useNavigate()
  const workspaces = useQuery(workspacesQueryOptions)
  const state = useQuery(membersQueryOptions(workspaceId))
  const invite = useInviteMember(workspaceId)
  const remove = useRemoveMember(workspaceId)
  const leave = useLeaveWorkspace(workspaceId)
  const [email, setEmail] = useState('')

  const workspace = workspaces.data?.find((w) => w.id === workspaceId)
  const can = (action: string) => state.data?.permissions.includes(action) ?? false

  function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = email.trim()
    if (trimmed === '') return
    invite.mutate(trimmed, { onSuccess: () => setEmail('') })
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <Link
        to="/workspaces"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Все пространства
      </Link>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        {workspace?.name ?? 'Участники'}
      </h1>

      {state.isPending && <Skeleton className="h-24 w-full" />}

      {state.isError && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <p className="mb-3 text-sm">
            {membersErrorText(state.error)}
          </p>
          <Button variant="outline" size="sm" onClick={() => state.refetch()}>
            Повторить
          </Button>
        </div>
      )}

      {state.data && (
        <>
          <ul className="divide-y rounded-lg border">
            {state.data.members.map((m) => (
              <li key={m.userId} className="flex items-center gap-3 p-4">
                <UserAvatar person={m} className="rounded-full" />
                <span className="truncate">{m.email}</span>
                <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {m.role === 'owner' ? 'владелец' : 'редактор'}
                </span>
                {/* Владельца снять нельзя вовсе — кнопки у него нет. */}
                {can('member.manage') && m.role !== 'owner' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto shrink-0"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(m.userId)}
                  >
                    <X className="size-4" />
                    Снять доступ
                  </Button>
                )}
              </li>
            ))}
          </ul>

          {state.data.invites.length > 0 && (
            <>
              <h2 className="mt-8 mb-2 text-sm font-medium text-muted-foreground">
                Приглашены, но ещё не вошли
              </h2>
              <ul className="divide-y rounded-lg border">
                {state.data.invites.map((inv) => (
                  <li key={inv.email} className="flex items-center gap-3 p-4">
                    <Mail className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{inv.email}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {can('member.manage') && (
            <form onSubmit={handleInvite} className="mt-8 border-t pt-6">
              <Label htmlFor="invite-email" className="mb-2 block">
                Пригласить по email
              </Label>
              <div className="flex gap-2">
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="coworker@example.com"
                />
                <Button type="submit" disabled={email.trim() === '' || invite.isPending}>
                  <UserPlus className="size-4" />
                  {invite.isPending ? 'Отправляем…' : 'Пригласить'}
                </Button>
              </div>
              {invite.isError && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {/* Ветвимся по code, а не по тексту: у каждого отказа свой
                      совет человеку, и «что-то пошло не так» тут бесполезно. */}
                  {inviteErrorText(invite.error)}
                </p>
              )}
              {invite.isSuccess && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Приглашение отправлено — ссылка придёт на почту.
                </p>
              )}
            </form>
          )}

          {/* Личное пространство не покидают: оно и есть пространство самого
              человека. Владелец тоже не может — у него нет этой кнопки. */}
          {workspace && !workspace.isPersonal && !can('member.manage') && (
            <div className="mt-8 border-t pt-6">
              <Button
                variant="outline"
                disabled={leave.isPending}
                onClick={() =>
                  leave.mutate(undefined, { onSuccess: () => navigate({ to: '/workspaces' }) })
                }
              >
                <LogOut className="size-4" />
                {leave.isPending ? 'Выходим…' : 'Покинуть пространство'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Заморозка — не поломка и не «оплатите возможность»: данные целы, вернуть
// доступ можно возвратом тарифа. Поэтому у неё свой код и свой текст.
function membersErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Не удалось загрузить участников.'
  switch (error.code) {
    case 'workspace_frozen':
      return 'Доступ закрыт: тариф больше не покрывает столько пространств или участников. Формы и ответы целы — доступ вернётся вместе с тарифом.'
    case 'not_found':
      return 'Пространство не найдено или доступ к нему закрыт.'
    default:
      return 'Не удалось загрузить участников.'
  }
}

function inviteErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Не удалось отправить приглашение.'
  switch (error.code) {
    case 'conflict':
      return 'Этот человек уже в пространстве.'
    case 'plan_required':
      return 'На текущем тарифе больше участников пригласить нельзя.'
    case 'validation_failed':
      return 'Проверьте адрес почты.'
    case 'forbidden':
      return 'Приглашать может только владелец пространства.'
    default:
      return 'Не удалось отправить приглашение.'
  }
}
