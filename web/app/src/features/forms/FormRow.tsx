import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { type Form, displayFormName } from '../../entities/form'
import { formatDate, pluralAnswers } from '../../shared/format'
import { RenameForm } from './RenameForm'
import { useDeleteForm, useDuplicateForm, useUpdateFormName } from './queries'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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

// FormRow — форма строкой (обзор пространств). То же, что FormCard, в раскладке
// списка: карточка нужна там, где формы — самостоятельный экран, строка — там, где
// они подпись к пространству и важнее видеть их разом.
//
// Сводка справа и действия занимают одно место: сводка гаснет по наведению, на её
// месте проступают кнопки. Прятать действия за прозрачностью, а не за display:none,
// обязательно — иначе они выпадают из порядка табуляции; видимыми при фокусе их
// делает group-focus-within, поэтому невидимой кнопки под фокусом не бывает.
export function FormRow({ form }: { form: Form }) {
  const [editing, setEditing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const rename = useUpdateFormName()
  const duplicate = useDuplicateForm()
  const remove = useDeleteForm()

  const label = displayFormName(form)
  const isPlaceholder = label === 'Без названия'

  if (editing) {
    return (
      <li className="px-3 py-2">
        <RenameForm
          initial={form.name ?? ''}
          pending={rename.isPending}
          onCancel={() => setEditing(false)}
          onSubmit={(name) =>
            rename.mutate({ id: form.id, name }, { onSuccess: () => setEditing(false) })
          }
        />
      </li>
    )
  }

  return (
    <li
      className="group relative flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent focus-within:bg-accent"
      aria-busy={remove.isPending || duplicate.isPending}
    >
      <Link
        // Куда ведёт название — то же правило, что на карточке дашборда: черновик
        // в редактор, розданную форму на «Ответы».
        to={form.status === 'draft' ? '/forms/$slug/edit' : '/forms/$slug/responses'}
        params={{ slug: form.slug }}
        className={`min-w-0 flex-1 truncate text-sm font-medium hover:text-primary ${
          isPlaceholder ? 'text-muted-foreground' : ''
        }`}
      >
        {label}
      </Link>

      <span className="shrink-0 text-xs text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
        {rowMeta(form)}
      </span>

      <span className="absolute right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" asChild>
          <Link to="/forms/$slug/edit" params={{ slug: form.slug }}>
            <Pencil className="size-3.5" />
            Изменить
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setConfirmOpen(true)}
          disabled={remove.isPending}
        >
          <Trash2 className="size-3.5" />
          <span className="sr-only">Удалить форму «{label}»</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7">
              <MoreHorizontal className="size-3.5" />
              <span className="sr-only">Действия с формой «{label}»</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to="/forms/$slug/responses" params={{ slug: form.slug }}>
                Ответы ({form.submissionCount})
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setEditing(true)}>Переименовать</DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => duplicate.mutate(form.id)}
              disabled={duplicate.isPending}
            >
              {duplicate.isPending ? 'Дублируем…' : 'Дублировать'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
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
              onClick={() => remove.mutate(form.id)}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

// Подпись строки: состояние, если оно не «обычное», число ответов и дата правки.
// «Опубликована» не пишем — это норма для розданной формы, а строка должна
// сообщать отличия, а не повторять фон. Черновику счётчик ответов не показываем:
// его никто не мог открыть (то же правило, что на карточке).
function rowMeta(form: Form): string {
  const parts: string[] = []
  if (form.status === 'draft') parts.push('Черновик')
  if (form.status === 'closed') parts.push('Закрыта')
  if (form.status !== 'draft') {
    parts.push(
      form.submissionCount === 0
        ? 'Пока нет ответов'
        : `${form.submissionCount} ${pluralAnswers(form.submissionCount)}`,
    )
  }
  parts.push(formatDate(form.updatedAt))
  return parts.join(' · ')
}
