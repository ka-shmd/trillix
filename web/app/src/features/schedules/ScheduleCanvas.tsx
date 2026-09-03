import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Calendar, { useCalendarController } from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/react/timegrid'
import interactionPlugin from '@fullcalendar/react/interaction'
import ruLocale from '@fullcalendar/react/locales/ru'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import '@fullcalendar/react/skeleton.css'
import './canvas.css'

import type { Booking, Schedule, ScheduleBlock, ScheduleInput } from '../../entities/schedule'
import {
  calendarQueryOptions,
  useAddBlock,
  useRemoveBlock,
  useUpdateSchedule,
} from '../../shared/schedules/queries'
import { Button } from '@/components/ui/button'
import { humanError } from '../../shared/api/errors'
import { LOCALE } from '../../shared/format'
import {
  clockOfNaive,
  dateKeys,
  dateOfNaive,
  shiftDate,
  spansIn,
  weekStart,
  type AvailabilitySpan,
} from './canvas'
import { applyGesture, docError, SNAP_MINUTES, type Gesture, type Scope } from './canvasEdit'
import { CanvasPopover, type Anchor } from './CanvasPopover'
import { zonedToUTC } from './zone'

// Полотно недели: часы приёма, исключения, занятое время и записи одним экраном.
//
// ЧЕТЫРЕ СЛОЯ, ДВА ИСТОЧНИКА. Часы приёма и исключения считаются из документа
// расписания прямо здесь (canvas.ts) — сервер про даты ничего нового не знает.
// Занятое время и записи приезжают ранжированной ручкой /calendar: они точки на оси
// времени и живут в базе.
//
// ВСЁ ПОКАЗЫВАЕТСЯ В ПОЯСЕ РАСПИСАНИЯ (`timeZone`), а не в поясе устройства: правило
// задано в нём, и поездка автора не должна сдвигать ему показ собственного распорядка
// (ADR §10). Именно ради именованных поясов взята седьмая ветка библиотеки.
export function ScheduleCanvas({ schedule }: { schedule: Schedule }) {
  const controller = useCalendarController()
  // Видимая неделя нужна ЭКРАНУ (от неё зависит запрос за занятым временем), но
  // ведёт её КАЛЕНДАРЬ: кнопки только просят его перелистнуть, а состояние приезжает
  // обратно из `datesSet`. Второй счётчик недель рядом с библиотечным разъехался бы
  // с ним на первой же навигации мимо кнопок — стрелками клавиатуры, например.
  const [firstDate, setFirstDate] = useState(() => weekStart(todayIn(schedule.timezone)))
  // Сколько дней в видимом отрезке — тоже от календаря: на узком экране их один, и
  // считать слой приёма на семь означало бы рисовать шесть невидимых колонок.
  const [visibleDays, setVisibleDays] = useState(7)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Документ ДО жеста: чип переключает область действия пересчётом от него.
  const beforeGesture = useRef<Schedule | null>(null)

  const dates = useMemo(() => dateKeys(firstDate, visibleDays), [firstDate, visibleDays])
  const window = useMemo(
    () => ({
      from: zonedToUTC(firstDate, '00:00', schedule.timezone),
      to: zonedToUTC(shiftDate(firstDate, visibleDays), '00:00', schedule.timezone),
    }),
    [firstDate, visibleDays, schedule.timezone],
  )
  const busy = useQuery(calendarQueryOptions(schedule.id, window.from, window.to))

  const update = useUpdateSchedule(schedule.id, schedule.workspaceId)
  const addBlock = useAddBlock(schedule.id)
  const removeBlock = useRemoveBlock(schedule.id)

  const events = useMemo(
    () => [
      ...spansIn(schedule.availability, dates).map(availabilityEvent),
      ...(busy.data?.blocks ?? []).map(blockEvent),
      ...(busy.data?.bookings ?? []).map(bookingEvent),
    ],
    [schedule.availability, dates, busy.data],
  )

  // saveAvailability — правка правила уходит на сервер СРАЗУ: полотно живёт по
  // законам календаря, а не формы с кнопкой «Сохранить». Параметры записи ниже по
  // странице сохраняются по-прежнему своей кнопкой — они не жест, а настройка.
  function saveAvailability(next: Schedule, onDone?: () => void) {
    const bad = docError(next.availability)
    if (bad) {
      setError(bad)
      return
    }
    setError(null)
    update.mutate(toInput(next), {
      onError: (e) => setError(humanError(e)),
      onSuccess: () => onDone?.(),
    })
  }

  // runGesture — применить жест областью по умолчанию и предложить вторую чипом.
  // Умолчание — «каждый вторник»: правило описывает обычную неделю, и чаще правят
  // именно его; исключение — это «в этот раз иначе», то есть более редкий случай.
  function runGesture(gesture: Gesture, at: { x: number; y: number }, date: string) {
    beforeGesture.current = schedule
    const next = withAvailability(schedule, applyGesture(schedule.availability, gesture, 'weekly'))
    saveAvailability(next)
    setAnchor({ kind: 'scope', x: at.x, y: at.y, date, gesture, scope: 'weekly' })
  }

  // switchScope — пересчёт ОТ ИСХОДНОГО документа, а не отмена применённого: щёлкать
  // чип можно сколько угодно, состояние не накапливается.
  function switchScope(gesture: Gesture, scope: Scope) {
    const before = beforeGesture.current ?? schedule
    saveAvailability(withAvailability(before, applyGesture(before.availability, gesture, scope)))
    setAnchor((a) => (a && a.kind === 'scope' ? { ...a, scope } : a))
  }

  // closeTime — третий ответ чипа: нарисованное было не приёмом, а занятостью.
  // Правило возвращается к исходному, а время закрывается блокировкой.
  function closeTime(gesture: Gesture, date: string) {
    if (gesture.kind !== 'create') return
    const before = beforeGesture.current ?? schedule
    saveAvailability(before, () => {
      addBlock.mutate(
        {
          startsAt: zonedToUTC(date, gesture.window.from, schedule.timezone),
          endsAt: zonedToUTC(date, endClock(gesture.window.to), schedule.timezone),
          note: '',
        },
        { onError: (e) => setError(humanError(e)) },
      )
    })
    setAnchor(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Предыдущая неделя"
            onClick={() => controller.prev()}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Следующая неделя"
            onClick={() => controller.next()}
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => controller.today()}>
            Сегодня
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              controller.changeView(visibleDays === 1 ? 'timeGridWeek' : 'timeGridDay')
            }
          >
            {visibleDays === 1 ? 'Неделя' : 'День'}
          </Button>
          <span className="ml-2 text-base font-semibold">{weekTitle(dates)}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Время в поясе расписания ({schedule.timezone})
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="sc-canvas rounded-lg border">
        <Calendar
          controller={controller}
          plugins={[timeGridPlugin, interactionPlugin]}
          initialView={narrowScreen() ? 'timeGridDay' : 'timeGridWeek'}
          initialDate={firstDate}
          timeZone={schedule.timezone}
          locale={ruLocale}
          firstDay={1}
          headerToolbar={false}
          allDaySlot={false}
          nowIndicator
          expandRows
          height="auto"
          slotDuration={{ minutes: 30 }}
          snapDuration={{ minutes: SNAP_MINUTES }}
          scrollTime="08:00"
          datesSet={(info) => {
            setFirstDate(dateOfNaive(info.startStr))
            setVisibleDays(daysBetween(info.startStr, info.endStr))
          }}
          selectable
          selectMirror
          editable
          eventDurationEditable
          eventStartEditable
          // Записи не двигаются мышью: их время — договорённость с человеком, а не
          // настройка. Меняется оно отменой и новой записью, а не перетаскиванием.
          eventOverlap
          events={events}
          eventClass={eventClass}
          select={(info) => {
            const date = dateOfNaive(info.startStr)
            runGesture(
              { kind: 'create', date, window: windowOf(info.startStr, info.endStr) },
              pointOf(info.jsEvent),
              date,
            )
          }}
          eventDrop={(info) => {
            const props = info.event.extendedProps as EventProps
            if (props.layer === 'block') {
              moveBlock(props.block, info.event.startStr, info.event.endStr)
              return
            }
            if (props.layer !== 'availability' || !info.event.startStr) return
            const date = dateOfNaive(info.event.startStr)
            const win = windowOf(info.event.startStr, info.event.endStr)
            const gesture: Gesture =
              date === props.date
                ? { kind: 'update', date, orig: props.window, window: win }
                : { kind: 'move', fromDate: props.date, orig: props.window, date, window: win }
            runGesture(gesture, pointOf(info.jsEvent), date)
          }}
          eventResize={(info) => {
            const props = info.event.extendedProps as EventProps
            if (props.layer === 'block') {
              moveBlock(props.block, info.event.startStr, info.event.endStr)
              return
            }
            if (props.layer !== 'availability') return
            runGesture(
              {
                kind: 'update',
                date: props.date,
                orig: props.window,
                window: windowOf(info.event.startStr, info.event.endStr),
              },
              pointOf(info.jsEvent),
              props.date,
            )
          }}
          eventClick={(info) => {
            const props = info.event.extendedProps as EventProps
            const at = pointOf(info.jsEvent)
            if (props.layer === 'availability') {
              setAnchor({ ...at, kind: 'window', date: props.date, window: props.window })
            } else if (props.layer === 'block') {
              setAnchor({ ...at, kind: 'block', block: props.block })
            } else {
              setAnchor({ ...at, kind: 'booking', booking: props.booking })
            }
          }}
        />
      </div>

      <CanvasPopover
        anchor={anchor}
        schedule={schedule}
        onClose={() => setAnchor(null)}
        onScope={switchScope}
        onCloseTime={closeTime}
        onRemoveWindow={(date, w, scope) => {
          beforeGesture.current = schedule
          const gesture: Gesture = { kind: 'remove', date, orig: w }
          saveAvailability(
            withAvailability(schedule, applyGesture(schedule.availability, gesture, scope)),
          )
          setAnchor(null)
        }}
        onRemoveBlock={(id) => {
          removeBlock.mutate(id, { onError: (e) => setError(humanError(e)) })
          setAnchor(null)
        }}
      />
    </div>
  )

  function moveBlock(block: ScheduleBlock, startStr: string, endStr: string) {
    // Блокировка переезжает удалением и заведением: своей правки у неё нет, а
    // заводить ручку PATCH ради перетаскивания дороже, чем два запроса.
    removeBlock.mutate(block.id, {
      onSuccess: () =>
        addBlock.mutate(
          {
            startsAt: zonedToUTC(dateOfNaive(startStr), clockOfNaive(startStr), schedule.timezone),
            endsAt: zonedToUTC(dateOfNaive(endStr), clockOfNaive(endStr), schedule.timezone),
            note: block.note,
          },
          { onError: (e) => setError(humanError(e)) },
        ),
      onError: (e) => setError(humanError(e)),
    })
  }
}

// EventProps — что полотно знает о своём событии. Слой обязателен: обработчики
// приходят одни на все четыре, и различать их по виду события нечем.
type EventProps =
  | { layer: 'availability'; date: string; window: { from: string; to: string }; source: string }
  | { layer: 'block'; block: ScheduleBlock }
  | { layer: 'booking'; booking: Booking }

function availabilityEvent(span: AvailabilitySpan) {
  return {
    id: `av:${span.date}:${span.window.from}-${span.window.to}`,
    start: span.start,
    end: span.end,
    display: 'auto',
    extendedProps: {
      layer: 'availability',
      date: span.date,
      window: span.window,
      source: span.source,
    } satisfies EventProps,
  }
}

function blockEvent(block: ScheduleBlock) {
  return {
    id: `bl:${block.id}`,
    start: block.startsAt,
    end: block.endsAt,
    title: block.note || 'Занято',
    extendedProps: { layer: 'block', block } satisfies EventProps,
  }
}

function bookingEvent(booking: Booking) {
  const start = new Date(booking.startsAt)
  return {
    id: `bk:${booking.id}`,
    start: booking.startsAt,
    end: new Date(start.getTime() + booking.durationMinutes * 60_000).toISOString(),
    title: booking.formTitle,
    // Записи не двигаются и не тянутся: время встречи — договорённость с человеком.
    startEditable: false,
    durationEditable: false,
    extendedProps: { layer: 'booking', booking } satisfies EventProps,
  }
}

// eventClass — слой красится классом, а не цветом в данных: цвета живут в токенах
// дизайн-системы, и второй набор в этом файле разъехался бы с ними.
//
// Строкой, а не списком: опция принимает одно имя класса (`ClassNameInput`), и массив
// молча не доехал бы.
function eventClass(info: { event: { extendedProps: Record<string, unknown> } }): string {
  const props = info.event.extendedProps as EventProps
  if (props.layer === 'availability') {
    return `sc-ev sc-av ${props.source === 'exception' ? 'sc-av-ex' : 'sc-av-weekly'}`
  }
  if (props.layer === 'block') return 'sc-ev sc-block'
  return 'sc-ev sc-booking'
}

// windowOf — пара отметок календаря в окно правила. Полночь СЛЕДУЮЩИХ суток — это
// «24:00» конца окна, а не ноль: иначе окно до полуночи схлопывалось бы в нулевое.
function windowOf(startStr: string, endStr: string): { from: string; to: string } {
  const from = clockOfNaive(startStr)
  const to = dateOfNaive(endStr) === dateOfNaive(startStr) ? clockOfNaive(endStr) : '24:00'
  return { from, to }
}

// endClock — «24:00» в отметку, которую понимает перевод в UTC.
function endClock(to: string): string {
  return to === '24:00' ? '23:59' : to
}

function pointOf(e: MouseEvent | null): { x: number; y: number } {
  return { x: e?.clientX ?? 0, y: e?.clientY ?? 0 }
}

function withAvailability(s: Schedule, availability: Schedule['availability']): Schedule {
  return { ...s, availability }
}

// toInput — расписание в тело PATCH. Перечислением, а не выбрасыванием служебных
// полей: новое поле обязано попасть сюда осознанно, иначе правка полотна молча
// сбрасывала бы его к прежнему значению.
function toInput(s: Schedule): ScheduleInput {
  return {
    name: s.name,
    timezone: s.timezone,
    availability: s.availability,
    slotMinutes: s.slotMinutes,
    bufferMinutes: s.bufferMinutes,
    horizonDays: s.horizonDays,
    leadMinutes: s.leadMinutes,
    capacity: s.capacity,
    maxSeatsPerBooking: s.maxSeatsPerBooking,
    showRemaining: s.showRemaining,
  }
}

// todayIn — сегодняшняя дата В ПОЯСЕ РАСПИСАНИЯ. Полночь у автора и полночь на его
// ноутбуке — разные моменты, и полотно обязано открываться на неделе расписания.
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

// daysBetween — сколько календарных дней в видимом отрезке. Через наивные даты, а
// не через разницу моментов: в сутки перевода часов их 23 или 25, и деление на 24
// давало бы шесть дней вместо семи.
function daysBetween(startStr: string, endStr: string): number {
  const from = dateOfNaive(startStr)
  const to = dateOfNaive(endStr)
  let days = 0
  for (let d = from; d < to && days < 31; d = shiftDate(d, 1)) days++
  return Math.max(days, 1)
}

// narrowScreen — открывать ли полотно днём вместо недели. Семь колонок на телефоне
// нечитаемы, а вид переключается кнопкой рядом.
function narrowScreen(): boolean {
  return typeof globalThis.matchMedia === 'function'
    ? globalThis.matchMedia('(max-width: 48rem)').matches
    : false
}

function weekTitle(dates: string[]): string {
  const first = dates[0]
  const last = dates[dates.length - 1]
  if (!first || !last) return ''
  const fmt = (d: string, withMonth: boolean) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(LOCALE, {
      timeZone: 'UTC',
      day: 'numeric',
      ...(withMonth ? { month: 'long' } : {}),
    })
  if (first === last) return fmt(first, true)
  const sameMonth = first.slice(0, 7) === last.slice(0, 7)
  return `${fmt(first, !sameMonth)} — ${fmt(last, true)}`
}
