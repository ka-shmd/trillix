import { useQuery } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'

import { type Booking } from '../../entities/schedule'
import { bookingsQueryOptions, useCancelBooking } from './queries'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { humanError } from '../../shared/api/errors'

// Ближайшие записи: кто придёт и когда. Имени и контактов здесь нет — они живут в
// ответе формы и подчиняются его правилам (152-ФЗ); отсюда ссылка на сам ответ.
//
// Время показывается в поясе РАСПИСАНИЯ, а не браузера (решение владельца
// 2026-09-03): распорядок задан в нём, и поездка автора не должна сдвигать ему показ
// собственного расписания.
export function UpcomingSection({
  scheduleId,
  timezone,
}: {
  scheduleId: string
  timezone: string
}) {
  const bookings = useQuery(bookingsQueryOptions(scheduleId))
  const cancel = useCancelBooking(scheduleId)

  return (
    <Section
      title="Ближайшие записи"
      description="Подтверждённые встречи начиная с текущего момента."
    >
      {bookings.isPending && <LoadingRows rows={2} />}
      {bookings.isError && (
        <ErrorState
          title="Не удалось загрузить записи."
          onRetry={() => void bookings.refetch()}
          retryLabel="Повторить"
        />
      )}

      {bookings.data && bookings.data.length === 0 && (
        <EmptyState
          icon={CalendarClock}
          title="Записей пока нет"
          description="Как только к вам запишутся через форму, встреча появится здесь."
        />
      )}

      {bookings.data && bookings.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {bookings.data.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="text-base font-semibold">{bookingTime(b, timezone)}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {b.formTitle}
                  {b.seats > 1 && ` · мест: ${b.seats}`}
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={cancel.isPending}>
                    Отменить
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Отменить запись?</AlertDialogTitle>
                    {/* Говорим прямо, что письма не будет: молчаливая отмена — это
                        человек, который придёт в назначенное время. Письмо появится
                        вместе с доставкой (слайс I фазы). */}
                    <AlertDialogDescription>
                      {bookingTime(b, timezone)} освободится и снова будет предлагаться в форме.
                      Записавшемуся об этом сообщить придётся вам — письма об отмене пока не уходят.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Оставить</AlertDialogCancel>
                    <AlertDialogAction onClick={() => cancel.mutate(b.id)}>
                      Отменить запись
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </li>
          ))}
        </ul>
      )}

      {cancel.isError && (
        <p role="alert" className="text-sm text-destructive">
          {humanError(cancel.error)}
        </p>
      )}
    </Section>
  )
}

function bookingTime(b: Booking, timezone: string): string {
  const at = new Date(b.startsAt)
  return at.toLocaleString('ru-RU', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}
