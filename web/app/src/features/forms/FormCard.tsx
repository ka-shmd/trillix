import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import { type Form, displayFormName } from '../../entities/form'
import { formatDate } from '../../shared/format'
import { FormStats } from './FormStats'
import { RenameForm } from './RenameForm'
import { useDeleteForm, useDuplicateForm, useUpdateFormName } from './queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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

const statusLabels: Record<Form['status'], string> = {
  draft: 'Черновик',
  published: 'Опубликована',
  closed: 'Закрыта',
}

const statusVariants: Record<Form['status'], 'secondary' | 'default' | 'outline'> = {
  draft: 'secondary',
  published: 'default',
  closed: 'outline',
}

// FormCard — карточка формы: заголовок ведёт в редактор, инлайн-переименование
// и удаление с подтверждением. Правки формы — серверный стейт, идут через мутации
// (инвалидируют список), локален только UI-стейт режима редактирования/диалога.
export function FormCard({ form }: { form: Form }) {
  const [editing, setEditing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const rename = useUpdateFormName()
  const duplicate = useDuplicateForm()
  const remove = useDeleteForm()

  // Подпись карточки — внутреннее имя, если задано, иначе показ по публичному
  // заголовку (фолбэк). Плейсхолдер «Без названия» приглушаем.
  const label = displayFormName(form)
  const isPlaceholder = label === 'Без названия'

  return (
    <Card
      className="flex min-h-36 flex-col gap-3 p-4"
      aria-busy={remove.isPending || duplicate.isPending}
    >
      {editing ? (
        // Переименование правит ВНУТРЕННЕЕ имя (name), не публичный заголовок.
        // Пусто = имя не задано; сохраняем непустым (сброс имени — отдельный кейс).
        <RenameForm
          initial={form.name ?? ''}
          pending={rename.isPending}
          onCancel={() => setEditing(false)}
          onSubmit={(name) =>
            rename.mutate({ id: form.id, name }, { onSuccess: () => setEditing(false) })
          }
        />
      ) : (
        <div className="flex items-start justify-between gap-2">
          <Link
            // Форму, которую уже публиковали (в т.ч. закрытую), открываем на «Ответы»:
            // она роздана, и ежедневный вопрос к ней — «что написали?», а не «где
            // ссылка?» (ссылка и сводка — соседние табы в один клик). Черновик — в
            // редактор: показывать ему три пустых таба вместо недоделанной формы незачем.
            to={form.status === 'draft' ? '/forms/$slug/edit' : '/forms/$slug/responses'}
            params={{ slug: form.slug }}
            className={`break-words text-base font-semibold hover:text-primary ${
              isPlaceholder ? 'text-muted-foreground' : ''
            }`}
          >
            {label}
          </Link>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 shrink-0">
                <MoreHorizontal className="size-4" />
                <span className="sr-only">Действия</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to="/forms/$slug/responses" search={(prev) => prev}
                params={{ slug: form.slug }}>
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
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
                disabled={remove.isPending}
              >
                Удалить
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-1.5 text-xs text-muted-foreground">
        {/* Черновику счётчик не показываем: его никто не мог открыть, и «Пока нет
            просмотров» на нём — не новость, а шум. */}
        {form.status !== 'draft' && (
          <FormStats
            visits={form.visitCount}
            submittedVisits={form.visitSubmittedCount}
            submissions={form.submissionCount}
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusVariants[form.status]}>{statusLabels[form.status]}</Badge>
          <span>Изменена {formatDate(form.updatedAt)}</span>
        </div>
      </div>

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
    </Card>
  )
}
