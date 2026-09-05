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
// ПЕРЕНОС СПРАШИВАЕТСЯ ПО ТОЙ ЖЕ ПРИЧИНЕ, ЧТО И ОТМЕНА (ADR §10): он задевает чужого
// человека и уходит письмом, которое двигает встречу в его календаре. Молчаливый
// перенос означал бы, что случайная протяжка мышью пишет незнакомому человеку.
//
// Диалог называет обе стороны: было и стало. И говорит правду про письмо — адрес
// живёт в ОТВЕТЕ формы, и у записи с удалённым ответом слать его некуда.
//
// Живёт в полотне, а не на странице (в отличие от отмены): вход у переноса ровно
// один — перетаскивание карточки. Отмену же спрашивают две поверхности сразу, и
// поэтому её диалог поднят на страницу.
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
  // onClose получает исход. Отказ и отмена обязаны вернуть карточку на место: в
  // полотне она уже переехала, а в базе — нет.
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
                  // Окно закрывается САМО по успеху: отказ сервера иначе остался бы
                  // за уже закрытым окном, а встреча выглядела бы перенесённой.
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
