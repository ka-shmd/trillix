import { useState } from 'react'
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

// Карточка записи: кто придёт, когда и как с ним связаться.
//
// Компонент только рисует. Данные собирает страница: они лежат в ответе формы, а
// ответы — чужая фича, импортировать её отсюда нельзя (web/CLAUDE.md).
export function BookingDetails({
  booking,
  timezone,
  people,
  answers,
  loading,
  onCancel,
  onClose,
}: {
  booking: Booking | null
  timezone: string
  // people — почта участника: подпись вопроса и ответ. Обычно одна строка.
  people: { label: string; value: string }[]
  // answers — остальные ответы анкеты, в порядке вопросов. Почта сюда не попадает —
  // она уже стоит выше участниками.
  answers: { label: string; value: string }[]
  loading: boolean
  onCancel: (booking: Booking) => void
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState(false)
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
                // Бронь переживает ответ: удалили ответ — контактов нет нигде.
                <p className="text-sm text-muted-foreground">
                  Ответ формы удалён — контактов не осталось.
                </p>
              ) : loading ? (
                <Skeleton className="h-9 w-full" />
              ) : people.length === 0 ? (
                // Законное состояние: без адреса не было ни письма, ни ссылки
                // отмены.
                <p className="text-sm text-muted-foreground">
                  В форме не заполнена почта — письма по этой записи не уходили.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {people.map((p) => (
                    <li key={p.label + p.value} className="flex items-center gap-2 text-sm">
                      <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />

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

            {/* Ответы анкеты в рамке: первые несколько, остальные раскрываются на
                месте — окно не должно расти на форму в двадцать вопросов. */}
            {booking.submissionId !== null && (loading || answers.length > 0) && (
              <div className="rounded-md border p-3">
                {loading ? (
                  <Skeleton className="h-16 w-full" />
                ) : (
                  <>
                    <dl className="flex flex-col gap-2">
                      {(expanded ? answers : answers.slice(0, PREVIEW)).map((a) => (
                        <div key={a.label} className="flex flex-col gap-0.5">
                          <dt className="text-xs text-muted-foreground">{a.label}</dt>
                          <dd className="text-sm break-words whitespace-pre-wrap">
                            {a.value || '—'}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    {answers.length > PREVIEW && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-2 px-0"
                        onClick={() => setExpanded((v) => !v)}
                      >
                        {expanded ? 'Свернуть' : `Показать ещё ${answers.length - PREVIEW}`}
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}

            <DialogFooter>
              {/* Отмена спрашивается своим диалогом, общим со списком ближайших:
                  вопрос, последствия и мутация обязаны быть одни. Это окно перед ним
                  закрывается. */}
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

// PREVIEW — сколько ответов видно до раскрытия.
const PREVIEW = 3

// when — «16 сентября, 11:00 — 12:00» в поясе РАСПИСАНИЯ: пояс браузера показал бы
// автору в поездке чужие числа на собственной встрече.
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
