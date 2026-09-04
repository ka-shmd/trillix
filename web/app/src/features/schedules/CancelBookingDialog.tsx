import type { Booking } from '../../entities/schedule'
import { useCancelBooking } from '../../shared/schedules/queries'
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

// CancelBookingDialog — подтверждение отмены записи.
//
// ОТМЕНА НЕОБРАТИМА И ЗАДЕВАЕТ ЧУЖОГО ЧЕЛОВЕКА, поэтому спрашивается диалогом. Он
// говорит обе стороны последствия: место вернётся в оборот, а записавшемуся уйдёт
// письмо, которое гасит встречу и в его календаре.
//
// ⚠ ПРО ПИСЬМО ГОВОРИТСЯ ЧЕСТНО. Адрес живёт в ОТВЕТЕ формы, и если ответ удалён,
// слать письмо некуда — тогда диалог прямо просит сообщить человеку самому. Обещать
// письмо там, где его не будет, — худший вид молчания: автор считает, что клиент
// предупреждён.
//
// ОДИН КОМПОНЕНТ НА ОБА ВХОДА — карточку записи на полотне и строку списка ближайших:
// вопрос, последствия и сама мутация обязаны быть одни. Два входа, отменяющие
// по-разному, — это два разных обещания на одно действие.
//
// Живёт на СТРАНИЦЕ, а не внутри полотна или списка: диалог, вложенный во всплывашку,
// умирает вместе с ней от первого же клика мимо неё — то есть по самому диалогу.
//
// Диалог закрывается только по успеху: отказ сервера иначе остался бы за уже закрытым
// окном, а место выглядело бы освобождённым.
export function CancelBookingDialog({
  scheduleId,
  booking,
  timezone,
  onClose,
}: {
  scheduleId: string
  booking: Booking | null
  timezone: string
  onClose: () => void
}) {
  const cancel = useCancelBooking(scheduleId)

  return (
    <AlertDialog
      open={booking !== null}
      onOpenChange={(open) => {
        if (!open) {
          cancel.reset()
          onClose()
        }
      }}
    >
      <AlertDialogContent>
        {booking && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Отменить запись?</AlertDialogTitle>
              <AlertDialogDescription>
                {bookingWhen(booking, timezone)} освободится и снова будет предлагаться в форме.{' '}
                {booking.submissionId
                  ? 'Записавшемуся уйдёт письмо об отмене — оно погасит встречу и в его календаре.'
                  : 'Ответ формы удалён, поэтому письмо отправить некуда: сообщите человеку сами.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {cancel.isError && (
              <p role="alert" className="text-sm text-destructive">
                {humanError(cancel.error)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Оставить</AlertDialogCancel>
              <AlertDialogAction
                disabled={cancel.isPending}
                onClick={(e) => {
                  // Окно закрывается САМО по успеху, а не по клику.
                  e.preventDefault()
                  cancel.mutate(booking.id, {
                    onSuccess: () => {
                      cancel.reset()
                      onClose()
                    },
                  })
                }}
              >
                {cancel.isPending ? 'Отменяем…' : 'Отменить запись'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

// bookingWhen — «4 сентября, 11:00» в поясе РАСПИСАНИЯ: прочитай его поясом браузера,
// и автор в поездке увидел бы чужое число на собственной встрече.
function bookingWhen(booking: Booking, timeZone: string): string {
  return new Date(booking.startsAt).toLocaleString(LOCALE, {
    timeZone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}
