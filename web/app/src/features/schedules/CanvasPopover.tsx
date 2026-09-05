import type { Booking, Schedule, ScheduleBlock } from '../../entities/schedule'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { LOCALE } from '../../shared/format'

// Что полотно «Календарь» показывает у точки, где щёлкнули. Вопросов к нему ровно
// два: «снять блокировку» и «что за запись».
//
// Часов приёма среди них нет: на датированной поверхности это подложка, и вопросы
// «что за время размечено» и «в каком объёме действует правило» на ней не возникают
// вовсе — на оба отвечает сама поверхность (ADR §10). Окно приёма, ставшее
// редактируемым в режиме правки часов одного дня, спрашивается своим попапом
// (WindowPopover) — тем же, что и на поверхности правила.
export type Anchor = { x: number; y: number } & (
  { kind: 'block'; block: ScheduleBlock } | { kind: 'booking'; booking: Booking }
)

export function CanvasPopover({
  anchor,
  schedule,
  onClose,
  onRemoveBlock,
  onOpenSubmission,
  onCancelBooking,
}: {
  anchor: Anchor | null
  schedule: Schedule
  onClose: () => void
  onRemoveBlock: (id: string) => void
  // Окно ответа рисует СТРАНИЦА, а не полотно: компонент окна живёт в фиче ответов,
  // а импорт фичи из фичи запрещён (web/CLAUDE.md). Отсюда наверх уходит только
  // «нажали на этот ответ».
  onOpenSubmission: (booking: Booking) => void
  // Отмена спрашивается диалогом, и рисует его СТРАНИЦА, а не этот попап: диалог,
  // вложенный в попап, живёт ровно до того момента, как попап закроется — а он
  // закрывается от первого же клика за своими пределами, то есть по самому диалогу.
  onCancelBooking: (booking: Booking) => void
}) {
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
        {anchor?.kind === 'block' && (
          <BlockCard block={anchor.block} timezone={schedule.timezone} onRemove={onRemoveBlock} />
        )}
        {anchor?.kind === 'booking' && (
          <BookingCard
            booking={anchor.booking}
            timezone={schedule.timezone}
            onOpen={() => {
              onOpenSubmission(anchor.booking)
              onClose()
            }}
            onCancel={() => {
              onCancelBooking(anchor.booking)
              onClose()
            }}
          />
        )}
      </PopoverContent>
    </Popover>
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
  onOpen,
  onCancel,
}: {
  booking: Booking
  timezone: string
  onOpen: () => void
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
        // ОТВЕТ ОТКРЫВАЕТСЯ ОКНОМ, А НЕ ПЕРЕХОДОМ НА СТРАНИЦУ ОТВЕТОВ (решение
        // владельца 2026-09-04): автор пришёл посмотреть, кто записался, а не искать
        // строку в таблице — и уводить его с расписания ради этого незачем.
        <Button size="sm" variant="ghost" className="justify-start px-0" onClick={onOpen}>
          Открыть ответ
        </Button>
      ) : (
        // Бронь переживает ответ: удалённый ответ оставляет запись без ссылки, и
        // молчание здесь читалось бы как «ссылку забыли».
        <p className="text-sm text-muted-foreground">Ответ удалён — запись осталась</p>
      )}
      <Button size="sm" variant="outline" onClick={onCancel}>
        Отменить запись
      </Button>
    </div>
  )
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
