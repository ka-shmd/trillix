import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Plus, User, Users } from 'lucide-react'
import { workspacesQueryOptions, useCreateWorkspace } from '../../features/workspaces/queries'
import { ApiError } from '../../shared/api/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

// Список пространств (/workspaces): куда переключиться и где завести новое.
// Пункт сайдбара рядом с «Формы» и «Тариф» — переключение отсюда, а не из
// выпадашки в шапке (решение владельца).
export const Route = createFileRoute('/_app/workspaces/')({
  component: WorkspacesPage,
})

function WorkspacesPage() {
  const workspaces = useQuery(workspacesQueryOptions)
  const create = useCreateWorkspace()
  const [name, setName] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '') return
    create.mutate(trimmed, { onSuccess: () => setName('') })
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Пространства</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Формы принадлежат пространству. Личное заводится вместе с аккаунтом, остальные — вы сами.
      </p>

      {workspaces.isPending && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {workspaces.isError && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <p className="mb-3 text-sm">Не удалось загрузить пространства.</p>
          <Button variant="outline" size="sm" onClick={() => workspaces.refetch()}>
            Повторить
          </Button>
        </div>
      )}

      {workspaces.data && (
        <ul className="space-y-2">
          {workspaces.data.map((ws) => (
            <li key={ws.id}>
              {/* Личное адресуется «/forms» без параметра — так же, как его
                  трактует сервер (нет workspaceId = личное). */}
              <Link
                to="/forms"
                search={ws.isPersonal ? {} : { w: ws.id }}
                className="flex items-center gap-3 rounded-lg border p-4 transition-colors hover:bg-accent"
              >
                {ws.isPersonal ? (
                  <User className="size-5 shrink-0 text-muted-foreground" />
                ) : (
                  <Users className="size-5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-medium">{ws.name}</span>
                {ws.isPersonal && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">личное</span>
                )}
              </Link>
              <Link
                to="/workspaces/$workspaceId"
                params={{ workspaceId: ws.id }}
                className="mt-1 inline-block pl-4 text-xs text-muted-foreground hover:text-foreground"
              >
                Участники
              </Link>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="mt-8 border-t pt-6">
        <Label htmlFor="workspace-name" className="mb-2 block">
          Новое пространство
        </Label>
        <div className="flex gap-2">
          <Input
            id="workspace-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, «Отдел маркетинга»"
            maxLength={60}
          />
          <Button type="submit" disabled={name.trim() === '' || create.isPending}>
            <Plus className="size-4" />
            {create.isPending ? 'Создаём…' : 'Создать'}
          </Button>
        </div>
        {create.isError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {/* Ветвимся по code, а не по тексту (web/CLAUDE.md): plan_required —
                не поломка, а упёрлись в тариф, и сказать это надо словами. */}
            {create.error instanceof ApiError && create.error.code === 'plan_required'
              ? 'На текущем тарифе больше пространств завести нельзя.'
              : 'Не удалось создать пространство. Попробуйте ещё раз.'}
          </p>
        )}
      </form>
    </div>
  )
}
