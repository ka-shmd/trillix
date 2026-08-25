import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LogOut, Mail, UserPlus, X } from 'lucide-react'
import type { Workspace } from '../../entities/workspace'
import { ApiError } from '../../shared/api/errors'
import { UserAvatar } from '../../shared/UserAvatar'
import {
  membersQueryOptions,
  useInviteMember,
  useLeaveWorkspace,
  useRemoveMember,
} from './queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

// MembersDialog — состав пространства и приглашения одним окном: открывается
// кластером кружков в обзоре (/workspaces), отдельного экрана участников нет.
// Кнопки рисуются по permissions с сервера — матрица прав живёт там в одном месте
// и в TypeScript не дублируется.
export function MembersDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: Workspace
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Состав спрашивается ТОЛЬКО У ОТКРЫТОГО окна: закрытое всё равно остаётся в
  // дереве (иначе оно не умеет появляться), а запрос состава идёт на КАЖДОЕ
  // пространство отдельно (N+1, §6 WORKSPACES.md) — и с блоком в сайдбаре это
  // происходило бы на каждом экране кабинета, а не на одном обзоре.
  const state = useQuery({ ...membersQueryOptions(workspace.id), enabled: open })
  const invite = useInviteMember(workspace.id)
  const remove = useRemoveMember(workspace.id)
  const leave = useLeaveWorkspace(workspace.id)
  const [email, setEmail] = useState('')

  const can = (action: string) => state.data?.permissions.includes(action) ?? false

  function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = email.trim()
    if (trimmed === '') return
    invite.mutate(trimmed, { onSuccess: () => setEmail('') })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Участники: {workspace.name}</DialogTitle>
          <DialogDescription>
            Кого пригласили в пространство. Формы и ответы видны всем участникам.
          </DialogDescription>
        </DialogHeader>

        {state.isPending && <Skeleton className="h-24 w-full" />}

        {state.isError && (
          <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <p className="mb-3 text-sm">{membersErrorText(state.error)}</p>
            <Button variant="outline" size="sm" onClick={() => state.refetch()}>
              Повторить
            </Button>
          </div>
        )}

        {state.data && (
          <>
            <ul className="divide-y rounded-lg border">
              {state.data.members.map((m) => (
                <li key={m.userId} className="flex items-center gap-3 p-3">
                  <UserAvatar person={m} className="size-8 shrink-0 rounded-full" />
                  <span className="min-w-0 flex-1 truncate text-sm">{m.email}</span>
                  <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {m.role === 'owner' ? 'владелец' : 'редактор'}
                  </span>
                  {/* Владельца снять нельзя вовсе — кнопки у него нет. */}
                  {can('member.manage') && m.role !== 'owner' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(m.userId)}
                    >
                      <X className="size-4" />
                      <span className="sr-only">Снять доступ: {m.email}</span>
                    </Button>
                  )}
                </li>
              ))}
            </ul>

            {state.data.invites.length > 0 && (
              <>
                <h3 className="text-sm font-medium text-muted-foreground">
                  Приглашены, но ещё не вошли
                </h3>
                <ul className="divide-y rounded-lg border">
                  {state.data.invites.map((inv) => (
                    <li key={inv.email} className="flex items-center gap-3 p-3">
                      <Mail className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm">{inv.email}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {can('member.manage') && (
              <form onSubmit={handleInvite} className="border-t pt-4">
                <Label htmlFor={`invite-${workspace.id}`} className="mb-2 block">
                  Пригласить по email
                </Label>
                <div className="flex gap-2">
                  <Input
                    id={`invite-${workspace.id}`}
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
            {!workspace.isPersonal && !can('member.manage') && (
              <div className="border-t pt-4">
                <Button
                  variant="outline"
                  disabled={leave.isPending}
                  onClick={() =>
                    // Список пространств инвалидирует сама мутация, и покинутое из
                    // него исчезает — окно закрываем, чтобы не остаться в диалоге
                    // пространства, которого на экране больше нет.
                    leave.mutate(undefined, { onSuccess: () => onOpenChange(false) })
                  }
                >
                  <LogOut className="size-4" />
                  {leave.isPending ? 'Выходим…' : 'Покинуть пространство'}
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
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
