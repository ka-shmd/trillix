import { useRef, useState } from 'react'
import Calendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/react/timegrid'
import interactionPlugin from '@fullcalendar/react/interaction'
import classicTheme from '@fullcalendar/react/themes/classic'
import ruLocale from '@fullcalendar/react/locales/ru'

// Скелет — вёрстка сетки, тема — её вид. Палитру темы мы НЕ импортируем: она
// переопределена нашими токенами в canvas.css.
import '@fullcalendar/react/skeleton.css'
import '@fullcalendar/react/themes/classic/theme.css'
import './canvas.css'

import type { Schedule, ScheduleInput, TimeWindow } from '../../entities/schedule'
import { useUpdateSchedule } from '../../shared/schedules/queries'
import { humanError } from '../../shared/api/errors'
import { clearBand, paintBand } from './band'
import {
  AXIS,
  dateOfNaive,
  ruleSpans,
  RULE_WEEK_DATES,
  scrollStart,
  selectionRect,
  windowOf,
  type AvailabilitySpan,
} from './canvas'
import { applyGesture, docError, SNAP_MINUTES, type Gesture } from './canvasEdit'
import { SurfaceTabs, type Surface } from './SurfaceTabs'
import { WindowPopover, type WindowAnchor } from './WindowPopover'

// ПОВЕРХНОСТЬ «ПРИЁМ» — недельное правило в его собственных координатах: семь
// колонок «Пн … Вс», дат нет вовсе (ADR §10).
//
// Ради этого поверхности и развели. На датированной неделе протяжка по вторнику
// 16 сентября законно читается двумя способами — «по вторникам» и «16-го», — и
// полотну приходилось спрашивать. Здесь спрашивать не о чем: у колонки нет числа,
// поэтому нарисованное окно может значить только «каждый вторник».
//
// СЛОЙ ЗДЕСЬ ОДИН. Ни записей, ни занятого времени, ни исключений: всё это точки на
// оси времени, а у оси времени нет «каждого вторника». Они живут на второй
// поверхности и правятся там.
export function RuleCanvas({
  schedule,
  surface,
  onSurface,
}: {
  schedule: Schedule
  surface: Surface
  onSurface: (s: Surface) => void
}) {
  const [anchor, setAnchor] = useState<WindowAnchor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  // Календарь целиком — ради одного `unselect()`, которого нет у контроллера.
  const calendarRef = useRef<{ unselect: () => void } | null>(null)

  // Куда прокручена сетка на открытии. Считается ОДИН РАЗ, при монтировании: пересчёт
  // на каждую правку дёргал бы полотно обратно к утру ровно в тот момент, когда автор
  // смотрит на вечер.
  const [scrollTo] = useState(() => scrollStart(schedule.availability))
  const update = useUpdateSchedule(schedule.id, schedule.workspaceId)
  const events = ruleSpans(schedule.availability).map(ruleEvent)

  // apply — жест сразу в документ и сразу на сервер, БЕЗ ВОПРОСОВ И БЕЗ УМОЛЧАНИЙ:
  // область действия задана самой поверхностью, а не выбором автора.
  function apply(gesture: Gesture) {
    const next = applyGesture(schedule.availability, gesture, 'weekly')
    const bad = docError(next)
    if (bad) {
      setError(bad)
      return
    }
    setError(null)
    update.mutate(toInput(schedule, next), { onError: (e) => setError(humanError(e)) })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <SurfaceTabs surface={surface} onSurface={onSurface} />
        <p className="hidden text-sm text-muted-foreground @3xl:block">
          Пояс расписания: {schedule.timezone}
        </p>
      </div>

      {/* Легенда здесь в одну строку: слой один, и объяснять больше нечего. Но и
          убрать её нельзя — цвет полосы обязан называться теми же словами, что на
          соседней поверхности. */}
      <div className="flex items-center gap-x-4 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="sc-key sc-key-av" aria-hidden />
          Приём — можно записаться
        </span>
        <span className="hidden @3xl:inline">
          Протяните мышью по колонке, чтобы задать часы приёма.
        </span>
      </div>

      {error && (
        <p role="alert" className="px-3 py-1.5 text-sm text-destructive">
          {error}
        </p>
      )}

      <div ref={canvasRef} className="sc-canvas sc-grid sc-rule min-h-0 flex-1 overflow-auto">
        <Calendar
          plugins={[timeGridPlugin, interactionPlugin, classicTheme]}
          initialView="timeGridWeek"
          // ОПОРНАЯ НЕДЕЛЯ, которую автор никогда не увидит числами (canvas.ts,
          // RULE_WEEK). Показывать её и листать нечего: неделя правила одна.
          initialDate={RULE_WEEK_DATES[0]}
          timeZone={schedule.timezone}
          locale={ruLocale}
          firstDay={1}
          headerToolbar={false}
          allDaySlot={false}
          // Линии «сейчас» здесь нет: «сейчас» — это точка на оси времени, а у
          // правила оси времени нет. На опорной неделе 2001 года она к тому же не
          // нарисовалась бы вовсе.
          expandRows
          height="100%"
          slotDuration={{ minutes: 30 }}
          snapDuration={{ minutes: SNAP_MINUTES }}
          slotHeaderInterval={{ hours: 1 }}
          slotHeaderFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
          displayEventEnd={false}
          slotMinTime={AXIS.min}
          slotMaxTime={AXIS.max}
          scrollTime={scrollTo}
          slotHeaderContent={(info) => <span className="sc-slot-label">{info.text}</span>}
          // ЗАГОЛОВОК КОЛОНКИ — ТОЛЬКО ИМЯ ДНЯ. Число здесь было бы враньём: колонка
          // означает «каждый вторник», а не какой-то конкретный вторник.
          dayHeaderContent={(info) => (
            <span className="sc-day-head">
              <span className="sc-day-name">{capitalize(info.weekdayText)}</span>
            </span>
          )}
          eventContent={() => <span className="sc-av-fill" />}
          eventClass={() => 'sc-ev sc-av sc-av-weekly'}
          events={events}
          selectable
          unselectCancel='[data-slot="popover-content"]'
          // Мираж выделения выключен: он рисует непрерывную кляксу поверх подсказки,
          // которую мы выправили в прямоугольник (ScheduleCanvas, тот же довод).
          selectMirror={false}
          highlightClass="sc-hl"
          dayLaneClass="sc-lane"
          // selectAllow — единственный обработчик, который вызывается на каждое
          // движение мыши; пересчёт подсказки живёт здесь. Значение всегда истинно:
          // этот обработчик ничего не запрещает.
          selectAllow={(span) => {
            paintBand(canvasRef.current, span.startStr, span.endStr)
            return true
          }}
          unselect={() => clearBand(canvasRef.current)}
          editable
          eventDurationEditable
          eventStartEditable
          select={(info) => {
            calendarRef.current = info.view.calendar
            // Протяжка на соседнюю колонку — ПРЯМОУГОЛЬНИК: те же часы на каждом
            // задетом дне, а не непрерывный отрезок «остаток вторника плюс начало
            // среды» (canvas.ts, selectionRect).
            const rect = selectionRect(info.startStr, info.endStr)
            if (!rect) return
            apply({ kind: 'create', ...rect })
            // Выделение снимается СРАЗУ, в отличие от датированной поверхности: там
            // оно жило, пока попап спрашивал, а здесь вопроса нет и держать его не
            // для чего — окно уже нарисовано.
            info.view.calendar.unselect()
            clearBand(canvasRef.current)
          }}
          eventDrop={(info) => {
            const props = info.event.extendedProps as RuleEventProps
            const date = dateOfNaive(info.event.startStr)
            const window = windowOf(info.event.startStr, info.event.endStr)
            apply(
              date === props.date
                ? { kind: 'update', date, orig: props.window, window }
                : { kind: 'move', fromDate: props.date, orig: props.window, date, window },
            )
          }}
          eventResize={(info) => {
            const props = info.event.extendedProps as RuleEventProps
            apply({
              kind: 'update',
              date: props.date,
              orig: props.window,
              window: windowOf(info.event.startStr, info.event.endStr),
            })
          }}
          eventClick={(info) => {
            const props = info.event.extendedProps as RuleEventProps
            setAnchor({
              x: info.jsEvent?.clientX ?? 0,
              y: info.jsEvent?.clientY ?? 0,
              date: props.date,
              window: props.window,
            })
          }}
        />
      </div>

      {/* Убрать окно можно только по клику: удаление плотным жестом (протащить за
          край сетки) на полотне не читается, а править правило автор приходит
          мышью. Вопроса об объёме здесь нет — на него ответила поверхность. */}
      <WindowPopover
        anchor={anchor}
        title="Убрать приём в этот день недели"
        onClose={() => setAnchor(null)}
        onRemove={(date, window) => {
          apply({ kind: 'remove', date, orig: window })
          setAnchor(null)
        }}
      />
    </div>
  )
}

// RuleEventProps — что полотно правила знает о своём событии. Слой не нужен: он
// здесь один.
type RuleEventProps = { date: string; window: TimeWindow }

function ruleEvent(span: AvailabilitySpan) {
  return {
    id: `rule:${span.date}:${span.window.from}-${span.window.to}`,
    start: span.start,
    end: span.end,
    extendedProps: { date: span.date, window: span.window } satisfies RuleEventProps,
  }
}

// toInput — расписание в тело PATCH с новым правилом. Перечислением, а не
// выбрасыванием служебных полей: новое поле обязано попасть сюда осознанно, иначе
// правка полотна молча сбрасывала бы его к прежнему значению.
function toInput(s: Schedule, availability: Schedule['availability']): ScheduleInput {
  return {
    name: s.name,
    timezone: s.timezone,
    availability,
    slotMinutes: s.slotMinutes,
    bufferMinutes: s.bufferMinutes,
    horizonDays: s.horizonDays,
    leadMinutes: s.leadMinutes,
    capacity: s.capacity,
    maxSeatsPerBooking: s.maxSeatsPerBooking,
    showRemaining: s.showRemaining,
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
