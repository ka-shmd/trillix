import { useDeletePartial, useDeleteSubmission } from './queries'
import { ROW_WORDS, type AnswerRow } from './rows'
import { formatDateTime } from '../../shared/format'
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

// Подтверждение удаления строки раздела «Ответы» — отправленного ответа или
// незавершённого. Действие необратимо и уносит чужие данные, поэтому подтверждение
// обязательно (docs/DESIGN-SYSTEM.md §7).
//
// ОДИН компонент на оба входа — значок в строке таблицы и кнопку в окне строки. Формулировка
// вопроса, перечень мест, откуда строка исчезнет, и сама мутация обязаны быть одни: два входа,
// удаляющие по-разному, — это два разных обещания на одно действие.
//
// Обе мутации вызываются ВСЕГДА, нужная выбирается по kind: хук под условием — это
// сломанный порядок хуков, а не экономия. Ни одна из них ничего не делает до mutate.
export function DeleteAnswerDialog({
  formId,
  row,
  open,
  onOpenChange,
  onDeleted,
}: {
  formId: string
  row: AnswerRow
  open: boolean
  onOpenChange: (open: boolean) => void
  // Что делает вызывающий после удаления: строка таблицы — ничего (список
  // инвалидируется мутацией), окно строки — закрывается, иначе показывало бы
  // удалённое.
  onDeleted?: () => void
}) {
  const removeSubmission = useDeleteSubmission(formId)
  const removePartial = useDeletePartial(formId)
  const remove = row.kind === 'partial' ? removePartial : removeSubmission
  const words = ROW_WORDS[row.kind]

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Удалить {words.oneLower} от {formatDateTime(row.at)}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Это действие необратимо. {words.deleteHint}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.isError && (
          <p role="alert" className="text-sm text-destructive">
            Не удалось удалить. Попробуйте ещё раз.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={remove.isPending}
            onClick={(e) => {
              // Окно закрывается САМО по успеху, а не по клику: отказ сервера иначе
              // остался бы за уже закрытым окном, и строка выглядела бы удалённой.
              e.preventDefault()
              remove.mutate(row.id, {
                onSuccess: () => {
                  onOpenChange(false)
                  onDeleted?.()
                },
              })
            }}
          >
            {remove.isPending ? 'Удаляем…' : 'Удалить'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
