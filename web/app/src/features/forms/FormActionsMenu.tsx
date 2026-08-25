import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { CopyPlus, Link2, MoreHorizontal, Pencil, TextCursorInput, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { type Form, displayFormName } from '../../entities/form'
import { copyFormLink } from './copyLink'
import { useDeleteForm, useDuplicateForm, useUpdateFormName } from './queries'
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
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Меню действий над формой у её названия на странице формы: редактировать,
// переименовать, копировать ссылку, дублировать, удалить.
//
// Переименование — ОКНО, а не инлайн-поле (как на карточке дашборда): здесь
// название стоит заголовком страницы, и подмена его на инпут увела бы вместе с
// собой крошки и табы, которые от него зависят.
//
// «Копировать ссылку» у черновика выключено: публичной страницы у него ещё нет —
// ссылка вела бы на 404. Это единственный пункт, зависящий от статуса.
export function FormActionsMenu({
  form,
}: {
  form: { id: string; slug: string; name: string | null; title: string; status: Form['status'] }
}) {
  const navigate = useNavigate()
  const rename = useUpdateFormName()
  const duplicate = useDuplicateForm()
  const remove = useDeleteForm()
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const label = displayFormName(form)

  // Дублирование НЕ уводит с формы: человек нажал действие над той, что открыта, и
  // подмена экрана на копию читалась бы как «меня куда-то унесло». Копия видна в
  // списке форм, о чём и говорит тост.
  function handleDuplicate() {
    duplicate.mutate(form.id, {
      onSuccess: (copy) => toast.success(`Создана копия «${displayFormName(copy)}»`),
      onError: () => toast.error('Не удалось создать копию'),
    })
  }

  function handleDelete() {
    remove.mutate(form.id, {
      onSuccess: () => {
        toast.success(`Форма «${label}» удалена`)
        void navigate({ to: '/forms', search: (prev) => prev })
      },
      onError: () => toast.error('Не удалось удалить форму'),
    })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            aria-label={`Действия с формой «${label}»`}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem asChild>
            <Link to="/forms/$slug/edit" params={{ slug: form.slug }} search={(prev) => prev}>
              <Pencil className="size-4" />
              Редактировать
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <TextCursorInput className="size-4" />
            Переименовать
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => copyFormLink(form.slug)}
            disabled={form.status === 'draft'}
          >
            <Link2 className="size-4" />
            Копировать ссылку
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleDuplicate} disabled={duplicate.isPending}>
            <CopyPlus className="size-4" />
            {duplicate.isPending ? 'Дублируем…' : 'Дублировать'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setConfirmDelete(true)}
            disabled={remove.isPending}
          >
            <Trash2 className="size-4" />
            Удалить
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        initial={form.name ?? ''}
        pending={rename.isPending}
        onSubmit={(name) =>
          rename.mutate({ id: form.id, name }, { onSuccess: () => setRenaming(false) })
        }
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить форму «{label}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Это действие необратимо. Все ответы формы также будут удалены.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// Правится ВНУТРЕННЕЕ имя формы (`name`), а не публичный заголовок (`title`) —
// последний живёт на полотне и виден респонденту. Пустое имя не отправляем: сброс
// имени — отдельный случай, которого у сервера нет.
function RenameDialog({
  open,
  onOpenChange,
  initial,
  pending,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: string
  pending: boolean
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState(initial)
  const trimmed = name.trim()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Открытие возвращает поле к текущему имени: окно живёт дольше одного
        // показа, и без сброса второй заход показал бы брошенный ввод.
        if (next) setName(initial)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (trimmed) onSubmit(trimmed)
          }}
        >
          <DialogHeader>
            <DialogTitle>Переименовать форму</DialogTitle>
            <DialogDescription>
              Название видно только в кабинете. Заголовок, который читает респондент, правится на
              полотне формы.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 flex flex-col gap-2">
            <Label htmlFor="form-rename">Название формы</Label>
            <Input
              id="form-rename"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              maxLength={200}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending || !trimmed}>
              {pending ? 'Сохраняем…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
