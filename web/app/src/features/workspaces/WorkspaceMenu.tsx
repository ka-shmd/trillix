import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CalendarClock, MoreHorizontal, Pencil, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import type { Workspace } from '../../entities/workspace'
import { membersQueryOptions, useDeleteWorkspace } from './queries'
import { Button } from '@/components/ui/button'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// WorkspaceMenu — «…» с действиями над пространством: одно меню на две
// поверхности (строка обзора и строка блока в сайдбаре), чтобы состав пунктов и
// прятание по правам не разъезжались между ними.
//
// В меню только ДЕЙСТВИЯ. Разделы пространства (участники, расписания)
// адресуются путём и живут в навигации: пункт меню, ведущий в раздел, и есть та
// причина, по которой расписания в кабинете было не найти
// (`docs/design/cabinet-navigation.md` §2). Ссылки ниже — переходные, до переезда
// навигации в сайдбар.
//
// Окно удаления живёт ВНУТРИ меню, а переименование — снаружи (`onRename`): оно
// правится прямо в строке обзора, и два владельца одного состояния дали бы две
// формы на одно имя.
//
// `onDeleted` зовётся после успешного удаления: формы снесённого пространства
// ушли вместе с ним, но ключи форм принадлежат чужой фиче — чистит их вызывающий.
export function WorkspaceMenu({
  workspace,
  onRename,
  onDeleted,
  trigger,
  align = 'start',
}: {
  workspace: Workspace
  onRename: () => void
  onDeleted?: () => void
  // trigger — своя кнопка вместо стандартной: в сайдбаре ей нужен вид
  // SidebarMenuAction, а не ghost-кнопки строки обзора.
  trigger?: React.ReactNode
  align?: 'start' | 'end'
}) {
  const remove = useDeleteWorkspace(workspace.id)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [open, setOpen] = useState(false)
  // Права берутся из ответа состава — того же, что читает кластер кружков (общий
  // ключ кэша). Матрица прав живёт на сервере, и кабинет не повторяет её на
  // TypeScript: спрашиваем действие, а не роль.
  //
  // СПРАШИВАЕТСЯ ПРИ ОТКРЫТИИ МЕНЮ, а не при отрисовке строки. Состав тянется на
  // КАЖДОЕ пространство отдельным запросом (N+1, §6 WORKSPACES.md), и меню живёт
  // не только на обзоре, но и в сайдбаре — то есть на каждом экране кабинета.
  // Незакрытый `enabled` означал бы N лишних запросов на любое открытие любой
  // страницы; закрытое меню же никаких пунктов не рисует, и знать права ему рано.
  const members = useQuery({ ...membersQueryOptions(workspace.id), enabled: open })
  const canManage = members.data?.permissions.includes('workspace.manage') ?? false
  const canDelete = members.data?.permissions.includes('workspace.delete') ?? false

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <Button variant="ghost" size="icon" className="size-7 shrink-0">
              <MoreHorizontal className="size-4" />
              <span className="sr-only">Действия с пространством «{workspace.name}»</span>
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          {canManage && (
            <DropdownMenuItem onClick={onRename}>
              <Pencil className="size-4" />
              Переименовать
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link to="/w/$workspaceSlug/members" params={{ workspaceSlug: workspace.slug }}>
              <Users className="size-4" />
              Участники
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/w/$workspaceSlug/schedules" params={{ workspaceSlug: workspace.slug }}>
              <CalendarClock className="size-4" />
              Расписания
            </Link>
          </DropdownMenuItem>
          {/* Личное не удаляется: человеку негде было бы жить, а его формы
              и подписка остались бы без места. Сервер отвергает это и сам
              (422) — здесь просто нет пункта, который заведомо откажет. */}
          {canDelete && !workspace.isPersonal && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-4" />
                Удалить
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteWorkspaceDialog
        workspace={workspace}
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setConfirmDelete(false)
              onDeleted?.()
            },
            onError: () => toast.error('Не удалось удалить пространство. Попробуйте ещё раз.'),
          })
        }
      />
    </>
  )
}

// Подтверждение сноса пространства. Удаление необратимо и уносит чужой труд —
// формы и ответы всех участников, — поэтому кнопка оживает только после того,
// как название набрано руками: «Удалить/Отмена» здесь слишком дёшево стоит.
function DeleteWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  workspace: Workspace
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const confirmed = typed.trim() === workspace.name

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Набранное не переживает закрытие: иначе повторное открытие встречало
        // бы уже готовым к нажатию то, что должно спрашиваться заново.
        if (!next) setTyped('')
        onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить пространство «{workspace.name}»?</AlertDialogTitle>
          <AlertDialogDescription>
            Вместе с ним безвозвратно удалятся все его формы ({workspace.formCount}), ответы
            респондентов и загруженные к ним файлы. Участники потеряют доступ. Отменить это нельзя.
            Введите название пространства, чтобы подтвердить.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Label htmlFor="confirm-delete-workspace" className="sr-only">
          Название пространства
        </Label>
        <Input
          id="confirm-delete-workspace"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={workspace.name}
          autoComplete="off"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            disabled={!confirmed || pending}
            onClick={(e) => {
              // Radix закрывает окно по клику на действие; здесь оно должно
              // дожить до ответа сервера — иначе отказ некому будет показать.
              e.preventDefault()
              onConfirm()
            }}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {pending ? 'Удаляем…' : 'Удалить'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
