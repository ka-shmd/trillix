import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LogOut, Mail, UserPlus, X } from 'lucide-react'

import type { Workspace } from '../../entities/workspace'
import { ApiError } from '../../shared/api/errors'
import { UserAvatar } from '../../shared/UserAvatar'
import { Section } from '../../shared/page/Section'
import { ErrorState, LoadingRows } from '../../shared/page/states'
import { membersQueryOptions, useInviteMember, useLeaveWorkspace, useRemoveMember } from './queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Состав пространства и приглашения — СТРАНИЦА (`/w/{slug}/members`), а не окно.
// Окном это было потому, что участники не были разделом: попасть к ним можно было
// только кластером кружков или пунктом «…», то есть найти их можно было лишь зная,
// где искать (спека `docs/design/cabinet-navigation.md` §2).
//
// Кнопки рисуются по `permissions` с сервера — матрица прав живёт там в одном месте
// и в TypeScript не дублируется: спрашиваем действие, а не роль.
export function MembersView({
  workspace,
  onLeft,
}: {
  workspace: Workspace
  // onLeft — куда уходить, покинув пространство: его страницы больше нет, и
  // остаться на ней нельзя. Переход задаёт маршрут.
  onLeft: () => void
}) {
  const state = useQuery(membersQueryOptions(workspace.id))
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

  if (state.isPending) return <LoadingRows rows={3} />
  if (state.isError) {
    return (
      <ErrorState
        title={membersErrorText(state.error)}
        onRetry={() => void state.refetch()}
        retryLabel="Повторить"
      />
    )
  }
  if (!state.data) return null

  return (
    <div className="flex flex-col gap-12">
      <Section
        title="Участники"
        description="Формы, ответы и расписания пространства видны всем, кто в нём состоит."
      >
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
      </Section>

      {/* Приглашённые отдаются только тому, кто может ими управлять: адреса
          позванных — не то, что нужно знать редактору (у него массив пуст). */}
      {state.data.invites.length > 0 && (
        <Section title="Приглашены, но ещё не вошли">
          <ul className="divide-y rounded-lg border">
            {state.data.invites.map((inv) => (
              <li key={inv.email} className="flex items-center gap-3 p-3">
                <Mail className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm">{inv.email}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {can('member.manage') && (
        <Section
          title="Пригласить"
          description="Ссылка придёт на почту; войдя по ней, человек станет редактором пространства."
        >
          <form onSubmit={handleInvite} className="max-w-lg">
            <Label htmlFor={`invite-${workspace.id}`} className="mb-2 block">
              Адрес почты
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
                {/* Ветвимся по code, а не по тексту: у каждого отказа свой совет
                    человеку, и «что-то пошло не так» тут бесполезно. */}
                {inviteErrorText(invite.error)}
              </p>
            )}
            {invite.isSuccess && (
              <p className="mt-2 text-sm text-muted-foreground">
                Приглашение отправлено — ссылка придёт на почту.
              </p>
            )}
          </form>
        </Section>
      )}

      {/* Личное пространство не покидают: оно и есть пространство самого человека.
          Владелец тоже не может — у него нет этой кнопки. */}
      {!workspace.isPersonal && !can('member.manage') && (
        <Section
          title="Выход"
          description="Формы и ответы останутся в пространстве — доступ к ним потеряете только вы."
        >
          <Button
            variant="outline"
            className="self-start"
            disabled={leave.isPending}
            onClick={() => leave.mutate(undefined, { onSuccess: onLeft })}
          >
            <LogOut className="size-4" />
            {leave.isPending ? 'Выходим…' : 'Покинуть пространство'}
          </Button>
        </Section>
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
