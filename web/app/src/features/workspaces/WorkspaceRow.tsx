import { useState } from 'react'
import { Link } from '@tanstack/react-router'

import { MAX_WORKSPACE_NAME_LEN, type Workspace } from '../../entities/workspace'
import { MemberCluster } from './MemberCluster'
import { WorkspaceMenu } from './WorkspaceMenu'
import { useRenameWorkspace } from './queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// WorkspaceRow — одно пространство строкой обзора: имя ссылкой в него, число форм,
// кружки участников, меню действий.
//
// ФОРМ ПОД СТРОКОЙ БОЛЬШЕ НЕТ. Обзор показывал их списком, и то же самое —
// в другом виде и по другому адресу — показывал экран самого пространства: два
// экрана на одну работу. Формы живут по одному адресу, `/w/{slug}/forms`, и обзор
// отвечает на единственный вопрос, на который экран самих форм ответить не может, —
// «какие у меня вообще пространства».
export function WorkspaceRow({
  workspace,
  onDeleted,
}: {
  workspace: Workspace
  onDeleted?: () => void
}) {
  const rename = useRenameWorkspace(workspace.id)
  const [renaming, setRenaming] = useState(false)

  if (renaming) {
    return (
      <div className="flex items-center gap-2 rounded-lg border p-3">
        <RenameWorkspaceForm
          initial={workspace.name}
          pending={rename.isPending}
          onCancel={() => setRenaming(false)}
          onSubmit={(name) => rename.mutate(name, { onSuccess: () => setRenaming(false) })}
        />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border p-3 transition-colors hover:bg-accent/50">
      <Link
        to="/w/$workspaceSlug/forms"
        params={{ workspaceSlug: workspace.slug }}
        className="min-w-0 flex-1 truncate text-base font-semibold hover:text-primary"
      >
        {workspace.name}
      </Link>
      {/* Число форм — с сервера (formCount): списка форм на этом экране больше нет,
          и считать их здесь не по чему. */}
      <span className="shrink-0 text-sm text-muted-foreground">
        {workspace.formCount} {formsWord(workspace.formCount)}
      </span>
      <MemberCluster workspace={workspace} />
      <WorkspaceMenu
        workspace={workspace}
        onRename={() => setRenaming(true)}
        onDeleted={onDeleted}
      />
    </div>
  )
}

function formsWord(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 14) return 'форм'
  switch (n % 10) {
    case 1:
      return 'форма'
    case 2:
    case 3:
    case 4:
      return 'формы'
    default:
      return 'форм'
  }
}

// Инлайн-переименование пространства прямо в строке: отдельный экран ради одного
// поля не нужен. Пустое имя не отправляем — совпадает с серверной валидацией (имя
// обязательно, потолок MAX_WORKSPACE_NAME_LEN рун).
function RenameWorkspaceForm({
  initial,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: string
  pending: boolean
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const trimmed = name.trim()

  return (
    <form
      className="flex flex-1 items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (trimmed !== '') onSubmit(trimmed)
      }}
    >
      <Label htmlFor="rename-workspace" className="sr-only">
        Название пространства
      </Label>
      <Input
        id="rename-workspace"
        value={name}
        onChange={(e) => setName(e.target.value)}
        // Escape отменяет правку не выходя из поля: тот же жест, что у полотна.
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
        }}
        autoFocus
        maxLength={MAX_WORKSPACE_NAME_LEN}
        className="h-8 max-w-xs"
      />
      <Button type="submit" size="sm" disabled={pending || trimmed === ''}>
        {pending ? 'Сохраняем…' : 'Сохранить'}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
        Отмена
      </Button>
    </form>
  )
}
