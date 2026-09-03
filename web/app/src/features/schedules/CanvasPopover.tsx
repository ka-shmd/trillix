import { Link } from '@tanstack/react-router'

import type { Booking, Schedule, ScheduleBlock, TimeWindow } from '../../entities/schedule'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useCancelBooking } from '../../shared/schedules/queries'
import { LOCALE } from '../../shared/format'
import { WEEKDAY_EVERY, weekdayOf } from './canvas'
import type { Gesture, Scope } from './canvasEdit'

// Что полотно показывает у точки, где щёлкнули. Четыре вида, потому что вопросов к
// полотну ровно четыре: «в каком объёме это правило», «убрать окно», «снять
// блокировку», «что за запись».
export type Anchor = { x: number; y: number } & (
  | { kind: 'scope'; date: string; gesture: Gesture; scope: Scope }
  | { kind: 'window'; date: string; window: TimeWindow }
  | { kind: 'block'; block: ScheduleBlock }
  | { kind: 'booking'; booking: Booking }
)

export function CanvasPopover({
  anchor,
  schedule,
  onClose,
  onScope,
  onCloseTime,
  onRemoveWindow,
  onRemoveBlock,
}: {
  anchor: Anchor | null
  schedule: Schedule
  onClose: () => void
  onScope: (gesture: Gesture, scope: Scope) => void
  onCloseTime: (gesture: Gesture, date: string) => void
  onRemoveWindow: (date: string, window: TimeWindow, scope: Scope) => void
  onRemoveBlock: (id: string) => void
}) {
  const cancel = useCancelBooking(schedule.id)

  return (
    <Popover open={anchor !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Якорь — точка мыши, а не элемент события: события полотна перерисовываются
          после каждой правки, и ссылка на прежний DOM-узел протухла бы ровно в тот
          момент, когда всплывашка должна открыться. */}
      <PopoverAnchor asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed"
          style={{ left: anchor?.x ?? 0, top: anchor?.y ?? 0 }}
        />
      </PopoverAnchor>
      <PopoverContent align="start" className="w-auto max-w-80 p-2">
        {anchor?.kind === 'scope' && (
          <ScopeChip anchor={anchor} onScope={onScope} onCloseTime={onCloseTime} />
        )}
        {anchor?.kind === 'window' && (
          <WindowCard anchor={anchor} onRemoveWindow={onRemoveWindow} />
        )}
        {anchor?.kind === 'block' && (
          <BlockCard block={anchor.block} timezone={schedule.timezone} onRemove={onRemoveBlock} />
        )}
        {anchor?.kind === 'booking' && (
          <BookingCard
            booking={anchor.booking}
            timezone={schedule.timezone}
            pending={cancel.isPending}
            onCancel={() => {
              cancel.mutate(anchor.booking.id)
              onClose()
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

// ScopeChip — тот самый вопрос, на который полотну нечем ответить самому: правка
// «каждый вторник» или «только 16 сентября». Умолчание УЖЕ ПРИМЕНЕНО, поэтому чип
// ничего не блокирует: не тронув его, автор получает правило.
function ScopeChip({
  anchor,
  onScope,
  onCloseTime,
}: {
  anchor: Extract<Anchor, { kind: 'scope' }>
  onScope: (gesture: Gesture, scope: Scope) => void
  onCloseTime: (gesture: Gesture, date: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="px-1 pb-1 text-sm text-muted-foreground">Это правило действует</p>
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant={anchor.scope === 'weekly' ? 'default' : 'outline'}
          onClick={() => onScope(anchor.gesture, 'weekly')}
        >
          {WEEKDAY_EVERY[weekdayOf(anchor.date)]}
        </Button>
        <Button
          size="sm"
          variant={anchor.scope === 'date' ? 'default' : 'outline'}
          onClick={() => onScope(anchor.gesture, 'date')}
        >
          Только {dayTitle(anchor.date)}
        </Button>
      </div>
      {/* Третий ответ есть только у протяжки по пустому месту: нарисованное было не
          приёмом, а занятостью. У переноса готового окна такого смысла нет. */}
      {anchor.gesture.kind === 'create' && (
        <Button
          size="sm"
          variant="ghost"
          className="justify-start"
          onClick={() => onCloseTime(anchor.gesture, anchor.date)}
        >
          Это не приём — закрыть время
        </Button>
      )}
    </div>
  )
}

function WindowCard({
  anchor,
  onRemoveWindow,
}: {
  anchor: Extract<Anchor, { kind: 'window' }>
  onRemoveWindow: (date: string, window: TimeWindow, scope: Scope) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="px-1 text-sm font-semibold">
        {anchor.window.from} — {anchor.window.to}
      </p>
      <p className="px-1 pb-1 text-sm text-muted-foreground">Убрать приём</p>
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRemoveWindow(anchor.date, anchor.window, 'weekly')}
        >
          {WEEKDAY_EVERY[weekdayOf(anchor.date)]}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRemoveWindow(anchor.date, anchor.window, 'date')}
        >
          Только {dayTitle(anchor.date)}
        </Button>
      </div>
    </div>
  )
}

function BlockCard({
  block,
  timezone,
  onRemove,
}: {
  block: ScheduleBlock
  timezone: string
  onRemove: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-sm font-semibold">Занятое время</p>
        <p className="text-sm text-muted-foreground">
          {range(block.startsAt, block.endsAt, timezone)}
        </p>
        {block.note && <p className="text-sm">{block.note}</p>}
      </div>
      <Button size="sm" variant="outline" onClick={() => onRemove(block.id)}>
        Снять
      </Button>
    </div>
  )
}

// BookingCard — имени и контактов записавшегося здесь НЕТ: они живут в ответе формы
// и подчиняются его правилам (152-ФЗ). Отсюда только ссылка на сам ответ.
function BookingCard({
  booking,
  timezone,
  pending,
  onCancel,
}: {
  booking: Booking
  timezone: string
  pending: boolean
  onCancel: () => void
}) {
  const end = new Date(new Date(booking.startsAt).getTime() + booking.durationMinutes * 60_000)
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-sm font-semibold">{booking.formTitle}</p>
        <p className="text-sm text-muted-foreground">
          {range(booking.startsAt, end.toISOString(), timezone)}
          {booking.seats > 1 && ` · мест: ${booking.seats}`}
        </p>
      </div>
      {booking.submissionId ? (
        <Link
          to="/forms/$slug/submissions"
          params={{ slug: booking.formSlug }}
          className="text-sm underline underline-offset-4"
        >
          Открыть ответ
        </Link>
      ) : (
        // Бронь переживает ответ: удалённый ответ оставляет запись без ссылки, и
        // молчание здесь читалось бы как «ссылку забыли».
        <p className="text-sm text-muted-foreground">Ответ удалён — запись осталась</p>
      )}
      <Button size="sm" variant="outline" disabled={pending} onClick={onCancel}>
        Отменить запись
      </Button>
    </div>
  )
}

function dayTitle(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(LOCALE, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
  })
}

// range — «14 сентября, 10:00 — 11:00» в поясе РАСПИСАНИЯ: прочитай его поясом
// браузера, и автор в поездке увидел бы чужие числа на своём же распорядке.
function range(startsAt: string, endsAt: string, timeZone: string): string {
  const from = new Date(startsAt)
  const to = new Date(endsAt)
  const day = from.toLocaleDateString(LOCALE, { timeZone, day: 'numeric', month: 'long' })
  const time = (d: Date) =>
    d.toLocaleTimeString(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit' })
  return `${day}, ${time(from)} — ${time(to)}`
}
