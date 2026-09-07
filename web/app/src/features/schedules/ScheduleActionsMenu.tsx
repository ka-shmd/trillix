import { useState } from 'react'
import { MoreHorizontal, TextCursorInput, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  MAX_SCHEDULE_NAME_LEN,
  scheduleInput,
  type ScheduleListItem,
} from '../../entities/schedule'
import { useDeleteSchedule, useUpdateSchedule } from '../../shared/schedules/queries'
import { humanError } from '../../shared/api/errors'
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

// Меню строки списка расписаний: переименовать и удалить.
//
// Оба действия ЖИВУТ И на странице расписания — в шторке «Параметры» (решение
// владельца 2026-09-04: на рабочем столе бар занят тем, чем пользуются каждый день).
// Здесь они не вторая копия того решения, а его продолжение: со списка внутрь идут
// ради самого расписания, а переименование и снос — работа НАД списком, и уходить за
// ними внутрь значит открывать экран, чтобы его же и закрыть.
//
// Правки настроек тут нет намеренно: часы приёма правятся на полотне, нарезка — в
// шторке, и вытащить их в строку значило бы завести третье место, где живёт то же.
export function ScheduleActionsMenu({ schedule }: { schedule: ScheduleListItem }) {
  const update = useUpdateSchedule(schedule.id, schedule.workspaceId)
  const remove = useDeleteSchedule(schedule.id, schedule.workspaceId)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Расписание правится ЦЕЛИКОМ (частичных патчей у него нет), поэтому переименование
  // отправляет весь документ с новым именем. Строка списка знает его полностью —
  // ходить за ним вторым запросом незачем.
  function handleRename(name: string) {
    update.mutate(
      { ...scheduleInput(schedule, schedule.availability), name },
      {
        onSuccess: () => setRenaming(false),
        onError: (e) => toast.error(humanError(e)),
      },
    )
  }

  // Отказ сервера здесь ОЖИДАЕМ и содержателен: у расписания есть будущие записи или
  // на него ссылается форма — он говорит, что именно мешает. Тост показывает его
  // текст, а не общее «не удалось».
  function handleDelete() {
    remove.mutate(undefined, {
      onSuccess: () => toast.success(`Расписание «${schedule.name}» удалено`),
      onError: (e) => toast.error(humanError(e)),
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
            aria-label={`Действия с расписанием «${schedule.name}»`}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <TextCursorInput className="size-4" />
            Переименовать
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
        initial={schedule.name}
        pending={update.isPending}
        onSubmit={handleRename}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить расписание «{schedule.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Действие необратимо. Отказать может сервер — у расписания есть будущие записи или на
              него ссылается форма; тогда он скажет, что именно мешает.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Оставить</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Удалить</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// Переименование — ОКНО, а не поле прямо в строке: подмена названия на инпут сдвинула
// бы колонки соседних строк. Тот же выбор, что у списка форм.
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

  function submit() {
    const next = name.trim()
    if (next === '') return
    onSubmit(next)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Имя набирается заново при каждом открытии: оставшееся от прошлой правки
        // показывало бы не то, что называется в заголовке строки.
        if (next) setName(initial)
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Переименовать расписание</DialogTitle>
          <DialogDescription>
            Имя называет того, кто принимает: «Мария — рисование». Формам, уже подключённым к
            расписанию, переименование ничего не меняет.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="schedule-rename">Название</Label>
          <Input
            id="schedule-rename"
            autoFocus
            value={name}
            maxLength={MAX_SCHEDULE_NAME_LEN}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button disabled={name.trim() === '' || pending} onClick={submit}>
            {pending ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
