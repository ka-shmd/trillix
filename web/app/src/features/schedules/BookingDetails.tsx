import { Mail } from 'lucide-react'

import type { Booking } from '../../entities/schedule'
import { LOCALE } from '../../shared/format'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'

// Карточка записи — ОКНО, а не всплывашка у точки мыши (решение владельца
// 2026-09-05). Всплывашка отвечала на «что это за встреча» одной строкой, а автор
// приходит к записи за человеком: кто придёт и как с ним связаться.
//
// Контакты записавшегося здесь ЕСТЬ, и это разворот прежнего решения — раньше
// карточка их не показывала, отсылая к самому ответу. Основание то же, что и было:
// адрес живёт в ответе формы; просто теперь он ещё и показывается, потому что
// «написать человеку» — обычное следующее действие после «посмотреть, кто придёт».
//
// Компонент ТОЛЬКО РИСУЕТ. Данные ему собирает страница: почта лежит в ответе формы,
// а ответы — чужая фича, и импортировать её отсюда нельзя (web/CLAUDE.md).
export function BookingDetails({
  booking,
  timezone,
  people,
  loading,
  onOpenSubmission,
  onCancel,
  onClose,
}: {
  booking: Booking | null
  timezone: string
  // people — что человек указал о себе: подпись вопроса и ответ. Обычно один адрес;
  // форма, спрашивающая почту дважды, честно покажет оба.
  people: { label: string; value: string }[]
  loading: boolean
  onOpenSubmission: (booking: Booking) => void
  onCancel: (booking: Booking) => void
  onClose: () => void
}) {
  return (
    <Dialog open={booking !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {booking && (
          <>
            <DialogHeader>
              <DialogTitle>{booking.formTitle}</DialogTitle>
              <DialogDescription>
                {when(booking, timezone)}
                {booking.seats > 1 && ` · мест: ${booking.seats}`}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2">
              <p className="text-sm font-semibold">Участники</p>
              {booking.submissionId === null ? (
                // Бронь ПЕРЕЖИВАЕТ ответ: удалили ответ — контактов больше нет
                // нигде, и молчание здесь читалось бы как «не загрузилось».
                <p className="text-sm text-muted-foreground">
                  Ответ формы удалён — контактов не осталось.
                </p>
              ) : loading ? (
                <Skeleton className="h-9 w-full" />
              ) : people.length === 0 ? (
                // Форма без вопроса про почту — законное состояние: тогда у записи
                // нет и ссылки отмены, и письма о ней тоже не было.
                <p className="text-sm text-muted-foreground">
                  В форме не заполнена почта — письма по этой записи не уходили.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {people.map((p) => (
                    <li key={p.label + p.value} className="flex items-center gap-2 text-sm">
                      <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      {/* Ссылка mailto, а не текст: «написать» — то, ради чего автор
                          сюда и пришёл, и копировать адрес глазами незачем. */}
                      <a
                        href={`mailto:${p.value}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {p.value}
                      </a>
                      <span className="truncate text-muted-foreground">{p.label}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <DialogFooter className="sm:justify-between">
              {booking.submissionId ? (
                <Button variant="ghost" onClick={() => onOpenSubmission(booking)}>
                  Открыть ответ
                </Button>
              ) : (
                <span />
              )}
              {/* Отмена спрашивается СВОИМ диалогом, общим со списком ближайших: вопрос,
                  перечень последствий и мутация обязаны быть одни. Это окно перед ним
                  закрывается — два окна подряд на одно действие читаются как два
                  разных действия. */}
              <Button variant="outline" onClick={() => onCancel(booking)}>
                Отменить запись
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// when — «16 сентября, 11:00 — 12:00» в поясе РАСПИСАНИЯ: прочитай его поясом
// браузера, и автор в поездке увидел бы чужие числа на собственной встрече.
function when(booking: Booking, timeZone: string): string {
  const from = new Date(booking.startsAt)
  const to = new Date(from.getTime() + booking.durationMinutes * 60_000)
  const day = from.toLocaleDateString(LOCALE, {
    timeZone,
    day: 'numeric',
    month: 'long',
    weekday: 'long',
  })
  const time = (d: Date) =>
    d.toLocaleTimeString(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit' })
  return `${capitalize(day)}, ${time(from)} — ${time(to)}`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
