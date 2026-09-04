import type { Booking, Schedule, ScheduleBlock, TimeWindow } from '../../entities/schedule'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { LOCALE } from '../../shared/format'
import { datesLabel, everyLabel, onlyLabel, WEEKDAY_EVERY, weekdayOf } from './canvas'
import type { Gesture, Scope } from './canvasEdit'

// Что полотно показывает у точки, где щёлкнули. Пять видов, потому что вопросов к
// полотну ровно пять: «что это за время», «в каком объёме это правило», «убрать
// окно», «снять блокировку», «что за запись».
export type Anchor = { x: number; y: number } &
  // СВЕЖАЯ ПРОТЯЖКА — ДВА ВОПРОСА ПОДРЯД, и до ответа на них не применено ничего
  // (решение владельца 2026-09-04: «сначала спрашивали, что ты хочешь на этих датах
  // сделать»). Первый вопрос — что это за время: приём или занятость. Он не про
  // объём, и отвечать на него угадыванием нельзя — приём и занятость это разные
  // слои, а не два оттенка одного.
  (
    | {
        kind: 'draw'
        gesture: Extract<Gesture, { kind: 'create' }>
        step: DrawStep
        scope: Scope | null
      }
    // Перетаскивание готового окна: что это за время, уже известно — спрашивается
    // только объём, и умолчание УЖЕ ПРИМЕНЕНО (жест сам показал результат).
    | { kind: 'scope'; dates: string[]; gesture: Gesture; scope: Scope }
    | { kind: 'window'; date: string; window: TimeWindow }
    | { kind: 'block'; block: ScheduleBlock }
    | { kind: 'booking'; booking: Booking }
  )

export type DrawStep = 'what' | 'scope'

export function CanvasPopover({
  anchor,
  schedule,
  onClose,
  onDrawStep,
  onScope,
  onCloseTime,
  onRemoveWindow,
  onRemoveBlock,
  onOpenSubmission,
  onCancelBooking,
}: {
  anchor: Anchor | null
  schedule: Schedule
  onClose: () => void
  // Переход ко второму вопросу. Состояние шага живёт НАВЕРХУ вместе с самим жестом:
  // попап рисует то, что ему дали, и своей памяти о жесте не держит.
  onDrawStep: (step: DrawStep) => void
  onScope: (gesture: Gesture, scope: Scope) => void
  onCloseTime: (gesture: Extract<Gesture, { kind: 'create' }>) => void
  onRemoveWindow: (date: string, window: TimeWindow, scope: Scope) => void
  onRemoveBlock: (id: string) => void
  // Окно ответа рисует СТРАНИЦА, а не полотно: компонент окна живёт в фиче ответов,
  // а импорт фичи из фичи запрещён (web/CLAUDE.md). Отсюда наверх уходит только
  // «нажали на этот ответ».
  onOpenSubmission: (booking: Booking) => void
  // Отмена спрашивается диалогом, и рисует его ПОЛОТНО, а не этот попап: диалог,
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
        {anchor?.kind === 'draw' && (
          <DrawCard
            anchor={anchor}
            onDrawStep={onDrawStep}
            onScope={onScope}
            onCloseTime={onCloseTime}
          />
        )}
        {anchor?.kind === 'scope' && (
          <ScopeChip
            dates={anchor.dates}
            gesture={anchor.gesture}
            scope={anchor.scope}
            onScope={onScope}
          />
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

// DrawCard — два вопроса к свежей протяжке, по одному на шаг.
//
// ПЕРВЫЙ ВОПРОС — ЧТО ЭТО ЗА ВРЕМЯ. До правки полотно отвечало на него само (рисовало
// приём) и спрашивало только про объём; автор получал приём там, где размечал
// занятость, и узнавал об этом по цвету полосы. Вопрос задаётся словами легенды —
// «Приём» и «Занято»: полотно не должно называть свои слои в двух местах по-разному.
//
// ВТОРОЙ ВОПРОС — ОБЪЁМ, и только у приёма: занятость это точки на оси времени, у неё
// недельного правила нет вовсе.
function DrawCard({
  anchor,
  onDrawStep,
  onScope,
  onCloseTime,
}: {
  anchor: Extract<Anchor, { kind: 'draw' }>
  onDrawStep: (step: DrawStep) => void
  onScope: (gesture: Gesture, scope: Scope) => void
  onCloseTime: (gesture: Extract<Gesture, { kind: 'create' }>) => void
}) {
  const { dates, window } = anchor.gesture
  return (
    <div className="flex flex-col gap-1">
      {/* Что именно размечено — числом и часами. Выделение с полотна снято в тот же
          миг, когда отпущена мышь (иначе библиотека оставляет свой непрерывный
          отрезок поверх сетки), поэтому предмет вопроса называет сам вопрос. */}
      <p className="px-1 text-sm font-semibold">
        {datesLabel(dates)}, {window.from} — {window.to}
      </p>
      {anchor.step === 'what' ? (
        <>
          <p className="px-1 pb-1 text-sm text-muted-foreground">Что это за время?</p>
          <Button size="sm" className="justify-start" onClick={() => onDrawStep('scope')}>
            Приём — можно записаться
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="justify-start"
            onClick={() => onCloseTime(anchor.gesture)}
          >
            Занято — записаться нельзя
          </Button>
        </>
      ) : (
        <ScopeChip dates={dates} gesture={anchor.gesture} scope={anchor.scope} onScope={onScope} />
      )}
    </div>
  )
}

// ScopeChip — тот самый вопрос, на который полотну нечем ответить самому: правка
// «каждый вторник» или «только 16 сентября».
//
// Щёлкать его можно сколько угодно: каждый ответ пересчитывается от документа ДО
// жеста, а не правит уже применённое. `scope === null` — ещё не отвечали (свежая
// протяжка), и тогда не выделена ни одна кнопка: подсвеченный ответ на незаданный
// вопрос читался бы как уже сделанный выбор.
function ScopeChip({
  dates,
  gesture,
  scope,
  onScope,
}: {
  dates: string[]
  gesture: Gesture
  scope: Scope | null
  onScope: (gesture: Gesture, scope: Scope) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="px-1 pb-1 text-sm text-muted-foreground">Это правило действует</p>
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant={scope === 'weekly' ? 'default' : 'outline'}
          onClick={() => onScope(gesture, 'weekly')}
        >
          {everyLabel(dates)}
        </Button>
        <Button
          size="sm"
          variant={scope === 'date' ? 'default' : 'outline'}
          onClick={() => onScope(gesture, 'date')}
        >
          {onlyLabel(dates)}
        </Button>
      </div>
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
