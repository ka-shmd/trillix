import { useState } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, MoreHorizontal, Plus } from 'lucide-react'
import type { Workspace } from '../../entities/workspace'
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'
import { MembersDialog } from './MembersDialog'
import { RenameWorkspaceDialog } from './RenameWorkspaceDialog'
import { WorkspaceMenu } from './WorkspaceMenu'
import { workspacesQueryOptions } from './queries'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar'

// WorkspacesNav — блок «Пространства» в сайдбаре: шапка (шеврон, ссылка на обзор,
// «+» на создание) и под ней все пространства человека, у каждого — меню действий
// и «+» на новую форму в нём.
//
// Живёт в фиче, а рисуется в оболочке: `AppSidebar` принимает его готовым узлом от
// маршрута `_app` — сам сайдбар презентационный и в фичи не ходит (импорт фичи из
// фичи запрещён, web/CLAUDE.md). Тем же приёмом маршрут отдаёт ему обработчики,
// которым нужна чужая фича: адрес редактора и ключи кэша форм — хозяйство форм.
export function WorkspacesNav({
  onCreateForm,
  onWorkspaceDeleted,
}: {
  onCreateForm: (workspace: Workspace) => void
  // onWorkspaceDeleted — формы снесённого пространства ушли вместе с ним, и их
  // страницы надо выбросить из кэша. Чистит вызывающий: ключи форм — чужая фича.
  onWorkspaceDeleted: () => void
}) {
  const workspaces = useQuery(workspacesQueryOptions)
  const [creating, setCreating] = useState(false)
  // Свёрнутость живёт в useState: она не переживает перезагрузку намеренно —
  // состояние экрана, а не выбор человека (то же решение, что у секции обзора).
  const [collapsed, setCollapsed] = useState(false)
  const listId = 'sidebar-workspaces'

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="gap-1 pl-0">
        <button
          type="button"
          className="flex size-6 items-center justify-center rounded-md hover:bg-sidebar-accent"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          aria-controls={listId}
        >
          {/* Один глиф с поворотом, а не два разных: направление шеврона и есть
              состояние, и анимация показывает переход между ними. */}
          <ChevronDown className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
          <span className="sr-only">
            {collapsed ? 'Показать пространства' : 'Свернуть пространства'}
          </span>
        </button>
        {/* Надпись остаётся ссылкой на обзор: блок показывает пространства
            списком, но экран, где под каждым видны его формы, никуда не делся. */}
        <Link to="/workspaces" className="min-w-0 flex-1 truncate hover:text-sidebar-foreground">
          Пространства
        </Link>
      </SidebarGroupLabel>

      <SidebarGroupAction onClick={() => setCreating(true)}>
        <Plus />
        <span className="sr-only">Новое пространство</span>
      </SidebarGroupAction>

      <SidebarGroupContent id={listId} hidden={collapsed}>
        <SidebarMenu>
          {workspaces.isPending && (
            <>
              <SidebarMenuItem>
                <SidebarMenuSkeleton />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuSkeleton />
              </SidebarMenuItem>
            </>
          )}
          {/* Отказ списка не рисует «Повторить»: сайдбар виден на каждом экране, и
              кнопка починки в нём спорила бы с содержимым страницы. Query сам
              перечитает список при возврате на вкладку. */}
          {workspaces.isError && (
            <SidebarMenuItem>
              <p role="alert" className="px-2 py-1 text-xs text-muted-foreground">
                Не удалось загрузить пространства.
              </p>
            </SidebarMenuItem>
          )}
          {workspaces.data?.map((ws) => (
            <WorkspaceNavItem
              key={ws.id}
              workspace={ws}
              onCreateForm={() => onCreateForm(ws)}
              onDeleted={onWorkspaceDeleted}
            />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>

      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </SidebarGroup>
  )
}

// Одно пространство строкой сайдбара. Свой компонент, а не кусок разметки в цикле:
// у каждой строки три собственных окна (состав, переименование, удаление), а хук
// на элемент списка иначе не заведёшь.
function WorkspaceNavItem({
  workspace,
  onCreateForm,
  onDeleted,
}: {
  workspace: Workspace
  onCreateForm: () => void
  onDeleted: () => void
}) {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [membersOpen, setMembersOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  // Разделы пространства живут под одним корнем, поэтому строка активна на любом
  // из них, а не только на списке форм.
  const isCurrent =
    pathname === `/w/${workspace.slug}` || pathname.startsWith(`/w/${workspace.slug}/`)

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isCurrent}>
        <Link to="/w/$workspaceSlug/forms" params={{ workspaceSlug: workspace.slug }}>
          <span className="truncate">{workspace.name}</span>
        </Link>
      </SidebarMenuButton>

      {/* Две кнопки в одной строке: у SidebarMenuAction абсолютное позиционирование
          с right-1, поэтому вторая отодвигается вручную. Прячутся по наведению и
          фокусу (showOnHover) — иначе имя пространства обрезалось бы всегда. */}
      <WorkspaceMenu
        workspace={workspace}
        align="end"
        onRename={() => setRenaming(true)}
        onMembers={() => setMembersOpen(true)}
        onDeleted={() => {
          onDeleted()
          // Стояли на странице снесённого пространства — уходим с неё: маршрут
          // остался бы с id, которого больше нет, и показал бы «не найдено».
          if (isCurrent) void navigate({ to: '/workspaces' })
        }}
        trigger={
          <SidebarMenuAction showOnHover className="right-7">
            <MoreHorizontal />
            <span className="sr-only">Действия с пространством «{workspace.name}»</span>
          </SidebarMenuAction>
        }
      />
      <SidebarMenuAction showOnHover onClick={onCreateForm}>
        <Plus />
        <span className="sr-only">Новая форма в пространстве «{workspace.name}»</span>
      </SidebarMenuAction>

      <MembersDialog workspace={workspace} open={membersOpen} onOpenChange={setMembersOpen} />
      <RenameWorkspaceDialog workspace={workspace} open={renaming} onOpenChange={setRenaming} />
    </SidebarMenuItem>
  )
}
