import { useDeleteSubmission } from './queries'
import { formatDateTime } from '../../shared/format'
import { type Submission } from '../../entities/submission'
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

// Подтверждение удаления ответа. Действие необратимо и уносит чужие данные, поэтому
// подтверждение обязательно (docs/DESIGN-SYSTEM.md §7).
//
// ОДИН компонент на оба входа — значок в строке таблицы и кнопку в окне ответа. Формулировка
// вопроса, перечень мест, откуда ответ исчезнет, и сама мутация обязаны быть одни: два входа,
// удаляющие по-разному, — это два разных обещания на одно действие.
export function DeleteSubmissionDialog({
  formId,
  submission,
  open,
  onOpenChange,
  onDeleted,
}: {
  formId: string
  submission: Submission
  open: boolean
  onOpenChange: (open: boolean) => void
  // Что делает вызывающий после удаления: строка таблицы — ничего (список
  // инвалидируется мутацией), окно ответа — закрывается, иначе показывало бы
  // удалённое.
  onDeleted?: () => void
}) {
  const remove = useDeleteSubmission(formId)

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Удалить ответ от {formatDateTime(submission.createdAt)}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Это действие необратимо. Ответ исчезнет из таблицы, выгрузки и сводки.
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
              // остался бы за уже закрытым окном, и ответ выглядел бы удалённым.
              e.preventDefault()
              remove.mutate(submission.id, {
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
