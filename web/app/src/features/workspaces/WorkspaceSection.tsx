import { useState } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { MAX_WORKSPACE_NAME_LEN, type Workspace } from '../../entities/workspace'
import { MemberCluster } from './MemberCluster'
import { MembersDialog } from './MembersDialog'
import { WorkspaceMenu } from './WorkspaceMenu'
import { useRenameWorkspace } from './queries'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// WorkspaceSection — одно пространство заголовком: имя, число форм, состав и
// действия. Формы под ним приходят ДЕТЬМИ (`children`), а не рисуются здесь:
// список принадлежит фиче форм, и импорт фичи из фичи запрещён (web/CLAUDE.md).
// Собирает их вместе маршрут — обзор всех пространств (/workspaces) и страница
// одного (/workspaces/{id}) отличаются только тем, сколько секций рисуют.
export function WorkspaceSection({
  workspace,
  onCreateForm,
  onDeleted,
  children,
}: {
  workspace: Workspace
  // onCreateForm — «+» у пространства: открывает редактор нового черновика ЭТОГО
  // пространства. Переход задаёт вызывающий: маршрут редактора и сентинел
  // черновика — хозяйство фичи форм.
  onCreateForm: () => void
  onDeleted?: () => void
  children: React.ReactNode
}) {
  const rename = useRenameWorkspace(workspace.id)
  // Диалог состава принадлежит секции, а не кластеру кружков: открыть его могут
  // двое — кластер и меню «…», а два владельца одного состояния дали бы два окна.
  const [membersOpen, setMembersOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  // Свёрнутость живёт в useState, а не в адресе и не в localStorage: она не
  // переживает перезагрузку намеренно — состояние экрана, а не выбор человека.
  const [collapsed, setCollapsed] = useState(false)
  // id списка нужен шеврону: без aria-controls кнопка объявляет, что она что-то
  // разворачивает, но не говорит что.
  const listId = `workspace-forms-${workspace.id}`

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        {renaming ? (
          <RenameWorkspaceForm
            initial={workspace.name}
            pending={rename.isPending}
            onCancel={() => setRenaming(false)}
            onSubmit={(name) => rename.mutate(name, { onSuccess: () => setRenaming(false) })}
          />
        ) : (
          <>
            <h2 className="min-w-0 truncate text-lg font-bold tracking-tight">{workspace.name}</h2>
            {/* Число форм — с сервера (formCount), а не длина загруженного списка:
                под пространством видна первая десятка, и счёт по ней врал бы. */}
            <span className="shrink-0 text-sm text-muted-foreground">{workspace.formCount}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground"
              onClick={() => setCollapsed((prev) => !prev)}
              aria-expanded={!collapsed}
              aria-controls={listId}
            >
              {/* Один глиф с поворотом, а не два разных: направление шеврона и
                  есть состояние, и анимация показывает переход между ними. */}
              <ChevronDown
                className={`size-4 transition-transform ${collapsed ? '-rotate-90' : ''}`}
              />
              <span className="sr-only">
                {collapsed
                  ? `Показать формы пространства «${workspace.name}»`
                  : `Свернуть формы пространства «${workspace.name}»`}
              </span>
            </Button>
            <WorkspaceMenu
              workspace={workspace}
              onRename={() => setRenaming(true)}
              onMembers={() => setMembersOpen(true)}
              onDeleted={onDeleted}
            />
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <MemberCluster workspace={workspace} onOpen={() => setMembersOpen(true)} />
          <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onCreateForm}>
            <Plus className="size-4" />
            <span className="sr-only">Новая форма в пространстве «{workspace.name}»</span>
          </Button>
        </div>
      </div>

      <MembersDialog workspace={workspace} open={membersOpen} onOpenChange={setMembersOpen} />

      <div id={listId} hidden={collapsed}>
        {children}
      </div>
    </section>
  )
}

// Инлайн-переименование пространства прямо в строке заголовка: отдельный экран
// ради одного поля не нужен. Пустое имя не отправляем — совпадает с серверной
// валидацией (имя обязательно, потолок MAX_WORKSPACE_NAME_LEN рун).
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
