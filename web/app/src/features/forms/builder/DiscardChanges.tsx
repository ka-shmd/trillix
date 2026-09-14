import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'

import { type FormDetail } from '../../../entities/form'
import { humanError } from '../../../shared/api/errors'
import { useDiscardDraft } from '../queries'
import { useBuilderStore } from './storeContext'
import { formLockToken } from './useAutosave'
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

// DiscardChanges — плашка «Есть изменения» в шапке редактора и откат черновика по ней:
// окно подтверждения, затем черновик возвращается к опубликованной версии. Откат
// необратим (решение владельца 2026-09-14): стор гидрируется ответом, и история правок
// обнуляется вместе с ними.
//
// hasUnpublishedChanges приходит с сервера на GET, а после каждого автосейва его
// проставляет сам автосейв (useAutosave) — иначе плашка появлялась бы только после
// перезагрузки страницы.
//
// canDiscard — черновик догнал редактор (то же условие, что у «Опубликовать»). Иначе
// откат гонится с идущим автосейвом за один токен блокировки, и проигравший получает
// 409 — терминальный «конфликт» полотна.
export function DiscardChanges({ form, canDiscard }: { form: FormDetail; canDiscard: boolean }) {
  const qc = useQueryClient()
  const hydrate = useBuilderStore((s) => s.hydrate)
  const discard = useDiscardDraft()
  const [open, setOpen] = useState(false)

  if (form.publishedVersion === null || !form.hasUnpublishedChanges) return null

  return (
    <>
      {/* Синий — потому что плашка нажимается (--primary = «сюда можно нажать»);
          полупрозрачный — чтобы не спорить с «Опубликовать» в том же ряду. */}
      <Badge
        asChild
        variant="outline"
        className="cursor-pointer border-transparent bg-primary/10 text-primary hover:bg-primary/15"
      >
        <button type="button" onClick={() => setOpen(true)}>
          Есть изменения
        </button>
      </Badge>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          {/* Крестик в углу вместо «Отмены» в подвале, устроен как в PublishControls.
              Cancel, а не свой обработчик: на нём же висят Escape и возврат фокуса. */}
          <AlertDialogCancel asChild variant="ghost" size="icon-sm">
            <button
              type="button"
              aria-label="Закрыть"
              className="text-muted-foreground absolute top-4 right-4"
            >
              <X className="size-4" />
            </button>
          </AlertDialogCancel>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить изменения?</AlertDialogTitle>
            <AlertDialogDescription>
              Черновик вернётся к опубликованной версии {form.publishedVersion}. Правки, сделанные
              после публикации, пропадут, и вернуть их будет нельзя.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {discard.isError && (
            <p role="alert" className="text-sm text-destructive">
              {humanError(discard.error, 'Не удалось удалить изменения. Попробуйте ещё раз.')}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={!canDiscard || discard.isPending}
              onClick={(e) => {
                // Окно закрывается по УСПЕХУ, а не по клику: отказ сервера иначе
                // остался бы за закрытым окном, а полотно — с правками.
                e.preventDefault()
                discard.mutate(
                  { id: form.id, updatedAt: formLockToken(qc, form.slug, form.updatedAt) },
                  {
                    onSuccess: (fresh) => {
                      hydrate(fresh.draftSchema)
                      setOpen(false)
                    },
                  },
                )
              }}
            >
              {discard.isPending ? 'Удаляем…' : 'Удалить изменения'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
