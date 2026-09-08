import { useState } from 'react'
import { Crown, MoreHorizontal, UserMinus } from 'lucide-react'

import type { Member } from '../../entities/member'
import { displayName } from '../../entities/user'
import { humanError } from '../../shared/api/errors'
import { formatDate } from '../../shared/format'
import { UserAvatar } from '../../shared/UserAvatar'
import { useRemoveMember, useTransferOwnership } from './queries'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Строка участника пространства. Действий над ней два, оба редкие и оба опасные
// (передать владение, снять доступ), поэтому они живут в меню «⋯», а не значками
// в строке (DESIGN-SYSTEM §7: «много или редкие — в DropdownMenu»), а
// деструктивное отделено разделителем.
//
// Рисуется по `permissions` с сервера: матрица прав живёт там в одном месте и в
// TypeScript не дублируется — спрашиваем действие, а не роль.
export function MemberRow({
  workspaceId,
  member,
  isMe,
  canManage,
  canTransfer,
}: {
  workspaceId: string
  member: Member
  // isMe — своя строка. Без пометки список из четырёх похожих адресов не
  // отвечает на первый же вопрос человека: «который тут я».
  isMe: boolean
  canManage: boolean
  canTransfer: boolean
}) {
  const [removing, setRemoving] = useState(false)
  const [transferring, setTransferring] = useState(false)

  const name = displayName(member)
  const isOwner = member.role === 'owner'
  // Владельца снять нельзя вовсе (пространство без плательщика — осиротевшее),
  // и себе передать пространство, которым уже владеешь, тоже нечего.
  const canRemoveThis = canManage && !isOwner
  const canTransferToThis = canTransfer && !isOwner && !isMe

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <UserAvatar person={member} className="size-9 shrink-0 rounded-full" />
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2 truncate text-base font-semibold">
            <span className="truncate">{name}</span>
            {isMe && <span className="shrink-0 text-sm text-muted-foreground">— вы</span>}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {/* Адрес повторяется под именем только когда имя — не он: у человека
                без имени вторая строка была бы копией первой. */}
            {name !== member.email && `${member.email} · `}в пространстве с{' '}
            {formatDate(member.joinedAt)}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Badge variant={isOwner ? 'secondary' : 'outline'}>
          {isOwner ? 'Владелец' : 'Редактор'}
        </Badge>
        {(canRemoveThis || canTransferToThis) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8">
                <MoreHorizontal className="size-4" />
                <span className="sr-only">Действия: {name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canTransferToThis && (
                <DropdownMenuItem onSelect={() => setTransferring(true)}>
                  <Crown className="size-4" />
                  Передать владение
                </DropdownMenuItem>
              )}
              {canTransferToThis && canRemoveThis && <DropdownMenuSeparator />}
              {canRemoveThis && (
                <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
                  <UserMinus className="size-4" />
                  Снять доступ
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {canRemoveThis && (
        <RemoveMemberDialog
          workspaceId={workspaceId}
          member={member}
          name={name}
          open={removing}
          onOpenChange={setRemoving}
        />
      )}
      {canTransferToThis && (
        <TransferOwnershipDialog
          workspaceId={workspaceId}
          member={member}
          name={name}
          open={transferring}
          onOpenChange={setTransferring}
        />
      )}
    </li>
  )
}

function RemoveMemberDialog({
  workspaceId,
  member,
  name,
  open,
  onOpenChange,
}: {
  workspaceId: string
  member: Member
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const remove = useRemoveMember(workspaceId)

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Снять доступ: {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Формы, ответы и расписания пространства останутся на месте — доступ к ним потеряет
            только этот человек. Вернуть его можно новым приглашением.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* Причина отказа — от сервера, а не общая фраза: отказы здесь бывают
            осмысленные (владельца снять нельзя вовсе), и «попробуйте ещё раз» на
            этом месте не просто бесполезно, а врёт — повтор не поможет никогда. */}
        {remove.isError && (
          <p role="alert" className="text-sm text-destructive">
            {humanError(remove.error, 'Не удалось снять доступ. Попробуйте ещё раз.')}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={remove.isPending}
            onClick={(e) => {
              // Окно закрывается по УСПЕХУ, а не по клику: отказ сервера иначе
              // остался бы за закрытым окном, и строка выглядела бы снятой.
              e.preventDefault()
              remove.mutate(member.userId, { onSuccess: () => onOpenChange(false) })
            }}
          >
            {remove.isPending ? 'Снимаем…' : 'Снять доступ'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function TransferOwnershipDialog({
  workspaceId,
  member,
  name,
  open,
  onOpenChange,
}: {
  workspaceId: string
  member: Member
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const transfer = useTransferOwnership(workspaceId)

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Передать владение: {name}?</AlertDialogTitle>
          {/* Три следствия названы поимённо, потому что назад их не отыграть:
              вернуть владение сможет только новый владелец, своей рукой. */}
          <AlertDialogDescription>
            Пространство начнёт работать по тарифу этого человека, и участниками, названием и
            тарифом дальше распоряжается он. Вы останетесь редактором и вернуть владение сами не
            сможете — только он.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {transfer.isError && (
          <p role="alert" className="text-sm text-destructive">
            {humanError(transfer.error, 'Не удалось передать владение. Попробуйте ещё раз.')}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            disabled={transfer.isPending}
            onClick={(e) => {
              e.preventDefault()
              transfer.mutate(member.userId, { onSuccess: () => onOpenChange(false) })
            }}
          >
            {transfer.isPending ? 'Передаём…' : 'Передать владение'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
