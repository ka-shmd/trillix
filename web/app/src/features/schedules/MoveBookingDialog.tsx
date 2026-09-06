import type { Booking } from '../../entities/schedule'
import { useMoveBooking } from '../../shared/schedules/queries'
import { humanError } from '../../shared/api/errors'
import { LOCALE } from '../../shared/format'
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

// MoveBookingDialog — подтверждение переноса записи.
//
// Спрашивается по той же причине, что и отмена (ADR §10): задевает чужого человека и
// уходит письмом. Диалог называет было и стало и говорит правду про письмо — адрес
// живёт в ответе формы, и у записи с удалённым ответом слать его некуда.
//
// Живёт в полотне: вход у переноса один — перетаскивание карточки. Отмену спрашивают
// и полотно, и список ближайших, поэтому её диалог поднят на страницу.
export function MoveBookingDialog({
  scheduleId,
  move,
  timezone,
  outsideHours,
  onClose,
}: {
  scheduleId: string
  // move — что и куда двигают. Пусто, пока никто ничего не тянул.
  move: { booking: Booking; startsAt: string } | null
  timezone: string
  // outsideHours — новое время лежит вне часов приёма. Не отказ, а предупреждение:
  // автор вправе поставить человека и туда, договорившись по телефону.
  outsideHours: boolean
  // onClose получает исход: при отказе полотно возвращает карточку на место.
  onClose: (moved: boolean) => void
}) {
  const mutation = useMoveBooking(scheduleId)

  return (
    <AlertDialog
      open={move !== null}
      onOpenChange={(open) => {
        if (!open) {
          mutation.reset()
          onClose(false)
        }
      }}
    >
      <AlertDialogContent>
        {move && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Перенести запись?</AlertDialogTitle>
              <AlertDialogDescription>
                Было: {when(move.booking.startsAt, timezone)}. Станет:{' '}
                {when(move.startsAt, timezone)}.{' '}
                {move.booking.submissionId
                  ? 'Записавшемуся уйдёт письмо о переносе — оно передвинет встречу и в его календаре.'
                  : 'Ответ формы удалён, поэтому письмо отправить некуда: сообщите человеку сами.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {outsideHours && (
              <p className="text-sm text-muted-foreground">
                Это время вне часов приёма. Записаться на него через форму нельзя, но поставить
                встречу вручную можно.
              </p>
            )}
            {mutation.isError && (
              <p role="alert" className="text-sm text-destructive">
                {humanError(mutation.error)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Оставить как было</AlertDialogCancel>
              <AlertDialogAction
                disabled={mutation.isPending}
                onClick={(e) => {
                  // Закрывается по успеху: иначе отказ сервера остался бы за
                  // закрытым окном.
                  e.preventDefault()
                  mutation.mutate(
                    { bookingId: move.booking.id, startsAt: move.startsAt },
                    {
                      onSuccess: () => {
                        mutation.reset()
                        onClose(true)
                      },
                    },
                  )
                }}
              >
                {mutation.isPending ? 'Переносим…' : 'Перенести'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

// when — «4 сентября, 11:00» в поясе РАСПИСАНИЯ: прочитай его поясом браузера, и
// автор в поездке увидел бы чужое число на собственной встрече.
function when(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString(LOCALE, {
    timeZone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}
