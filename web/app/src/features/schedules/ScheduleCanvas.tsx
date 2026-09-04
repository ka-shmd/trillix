import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Calendar, { useCalendarController } from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/react/timegrid'
import dayGridPlugin from '@fullcalendar/react/daygrid'
import interactionPlugin from '@fullcalendar/react/interaction'
import classicTheme from '@fullcalendar/react/themes/classic'
import ruLocale from '@fullcalendar/react/locales/ru'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// Скелет — вёрстка сетки, тема — её вид. Палитру темы мы НЕ импортируем: она
// переопределена нашими токенами в canvas.css.
import '@fullcalendar/react/skeleton.css'
import '@fullcalendar/react/themes/classic/theme.css'
import './canvas.css'

import type { Booking, Schedule, ScheduleBlock, ScheduleInput } from '../../entities/schedule'
import {
  calendarQueryOptions,
  useAddBlock,
  useCancelBooking,
  useRemoveBlock,
  useUpdateSchedule,
} from '../../shared/schedules/queries'
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
} from '@/components/ui/alert-dialog'
import { humanError } from '../../shared/api/errors'
import { LOCALE } from '../../shared/format'
import {
  clockOfNaive,
  dateKeys,
  dateOfNaive,
  bandBox,
  effectiveWindows,
  selectionRect,
  shiftDate,
  spansIn,
  weekStart,
  type AvailabilitySpan,
} from './canvas'
import { applyGesture, docError, SNAP_MINUTES, type Gesture, type Scope } from './canvasEdit'
import { clockToMinutes, minutesToClock } from './weekly'
import { CanvasPopover, type Anchor } from './CanvasPopover'
import { zonedParts, zonedToUTC } from './zone'

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
export function ScheduleCanvas({
  schedule,
  goToDate,
  onRange,
  onOpenSubmission,
}: {
  schedule: Schedule
  // goToDate — дата, выбранная снаружи (мини-календарь слева, строка ближайшей
  // записи). Полотно листает себя к ней и НЕ спорит с ней о виде: месяц остаётся
  // месяцем, неделя неделей — человек выбрал день, а не способ на него смотреть.
  goToDate?: string
  // onRange — какой отрезок сейчас показан. Нужен мини-календарю, чтобы подсветить
  // видимые дни: без этого две половины экрана живут каждая своей неделей.
  onRange?: (dates: string[]) => void
  // Окно ответа рисует страница: компонент окна живёт в фиче ответов, а импорт фичи
  // из фичи запрещён. Полотно только сообщает, что нажали.
  onOpenSubmission: (booking: Booking) => void
}) {
  const controller = useCalendarController()
  // Видимая неделя нужна ЭКРАНУ (от неё зависит запрос за занятым временем), но
  // ведёт её КАЛЕНДАРЬ: кнопки только просят его перелистнуть, а состояние приезжает
  // обратно из `datesSet`. Второй счётчик недель рядом с библиотечным разъехался бы
  // с ним на первой же навигации мимо кнопок — стрелками клавиатуры, например.
  const [firstDate, setFirstDate] = useState(() => weekStart(todayIn(schedule.timezone)))
  // Сколько дней в видимом отрезке — тоже от календаря: на узком экране их один, и
  // считать слой приёма на семь означало бы рисовать шесть невидимых колонок.
  const [visibleDays, setVisibleDays] = useState(7)
  const [view, setView] = useState<ViewName>(() =>
    narrowScreen() ? 'timeGridDay' : 'timeGridWeek',
  )
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  // Запись, отмену которой подтверждают. Диалог рисует полотно, а не попап: попап
  // закрывается от клика за своими пределами, унося с собой вложенный диалог.
  const [cancelling, setCancelling] = useState<Booking | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Документ ДО жеста: чип переключает область действия пересчётом от него.
  const beforeGesture = useRef<Schedule | null>(null)
  // Контейнер нужен ИМПЕРАТИВНО: подсказка перерисовывается на каждое движение мыши,
  // и гонять через состояние React перерисовку всего полотна на каждый кадр —
  // заведомо рвано.
  const canvasRef = useRef<HTMLDivElement>(null)

  const dates = useMemo(() => dateKeys(firstDate, visibleDays), [firstDate, visibleDays])

  // Внешний выбор даты — императивная команда календарю, а не второе состояние:
  // источник правды о показанном отрезке один, и это сам календарь (datesSet).
  useEffect(() => {
    if (goToDate) controller.gotoDate(goToDate)
  }, [goToDate, controller])

  useEffect(() => {
    onRange?.(dates)
  }, [dates, onRange])
  const window = useMemo(
    () => ({
      from: zonedToUTC(firstDate, '00:00', schedule.timezone),
      to: zonedToUTC(shiftDate(firstDate, visibleDays), '00:00', schedule.timezone),
    }),
    [firstDate, visibleDays, schedule.timezone],
  )
  const busy = useQuery(calendarQueryOptions(schedule.id, window.from, window.to))

  const update = useUpdateSchedule(schedule.id, schedule.workspaceId)
  const cancel = useCancelBooking(schedule.id)
  const addBlock = useAddBlock(schedule.id)
  const removeBlock = useRemoveBlock(schedule.id)

  const month = view === 'dayGridMonth'
  const events = useMemo(
    () => [
      // В месяце полос приёма нет: тридцать полос превратили бы клетки в кашу, а
      // «работаю — не работаю» там показывает приглушённый день (dayCellClass).
      ...(month ? [] : spansIn(schedule.availability, dates).map(availabilityEvent)),
      ...(busy.data?.blocks ?? []).map(blockEvent),
      ...(busy.data?.bookings ?? []).map(bookingEvent),
    ],
    [schedule.availability, dates, busy.data, month],
  )

  // Дни видимого отрезка, в которые приём вообще ведётся, — месяцу.
  const workingDays = useMemo(
    () =>
      new Set(dates.filter((d) => effectiveWindows(schedule.availability, d).windows.length > 0)),
    [schedule.availability, dates],
  )

  // Границы оси часов: от самого раннего окна приёма до самого позднего, с запасом
  // в час, но не уже рабочего дня и не шире суток. Считаются и по занятому времени
  // тоже — встреча, назначенная до открытия приёма, обязана быть видна.
  const hours = useMemo(() => axisHours(schedule, dates, busy.data), [schedule, dates, busy.data])

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
  function runGesture(gesture: Gesture, at: { x: number; y: number }, dates: string[]) {
    beforeGesture.current = schedule
    const next = withAvailability(schedule, applyGesture(schedule.availability, gesture, 'weekly'))
    saveAvailability(next)
    setAnchor({ kind: 'scope', x: at.x, y: at.y, dates, gesture, scope: 'weekly' })
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
  function closeTime(gesture: Gesture) {
    if (gesture.kind !== 'create') return
    const before = beforeGesture.current ?? schedule
    saveAvailability(before, () => {
      // По блокировке на каждый задетый день: занятое время — точки на оси, и одной
      // строкой «со вторника по четверг» они не выражаются (иначе закрытой оказалась
      // бы и ночь между днями).
      for (const date of gesture.dates) {
        addBlock.mutate(
          {
            startsAt: zonedToUTC(date, gesture.window.from, schedule.timezone),
            endsAt: zonedToUTC(date, endClock(gesture.window.to), schedule.timezone),
            note: '',
          },
          { onError: (e) => setError(humanError(e)) },
        )
      }
    })
    setAnchor(null)
  }

  return (
    // Полотно занимает ВСЮ высоту отведённой панели: панель управления и легенда
    // сверху не растягиваются, а сетка забирает остаток (min-h-0 обязателен — без
    // него flex-элемент не сжимается ниже содержимого, и сетка вылезает за экран).
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
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
          <span className="ml-2 text-base font-semibold">{rangeTitle(dates, view)}</span>
          {/* «Сегодня» стоит ПОСЛЕ дат (решение владельца 2026-09-04): стрелки и
              заголовок отрезка — про то, где мы сейчас, а возврат к текущему дню
              читается следом, как выход из прогулки по календарю. */}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => controller.today()}>
            Сегодня
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <p className="hidden text-sm text-muted-foreground @3xl:block">
            Пояс расписания: {schedule.timezone}
          </p>
          {/* Переключатель видов — сегментами, а не тремя одинаковыми кнопками:
              выбран всегда ровно один, и группа должна читаться как один орган
              управления. */}
          <div className="flex rounded-md border p-0.5">
            {VIEWS.map((v) => (
              <button
                key={v.name}
                type="button"
                aria-pressed={view === v.name}
                className={
                  view === v.name
                    ? 'rounded-sm bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground'
                    : 'rounded-sm px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground'
                }
                onClick={() => controller.changeView(v.name)}
              >
                {v.title}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Легенда РАЗНАЯ у видов, и это не украшение: в месяце полос приёма нет вовсе
          (там приглушён день без приёма), и строка «Приём» объясняла бы цвет, которого
          на экране нет. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-1.5 text-xs text-muted-foreground">
        {month ? (
          <Legend className="sc-key-off" title="День без приёма" />
        ) : (
          <>
            <Legend className="sc-key-av" title="Приём" />
            <Legend className="sc-key-ex" title="Только в этот день" />
          </>
        )}
        <Legend className="sc-key-block" title="Занято" />
        <Legend className="sc-key-booking" title="Запись" />
      </div>

      {error && (
        <p role="alert" className="px-3 py-1.5 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* Класс вида на КОНТЕЙНЕРЕ, а не на самом виде: правила слоения должны
          действовать только в сетке времени, а `viewClass` вешает класс глубже, чем
          живут обёртки событий. */}
      <div
        ref={canvasRef}
        className={`sc-canvas min-h-0 flex-1 overflow-auto ${month ? 'sc-month' : 'sc-grid'}`}
      >
        <Calendar
          controller={controller}
          plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin, classicTheme]}
          initialView={view}
          // Сегодня, а не понедельник недели: отрезок выбирает сам вид, и в виде дня
          // понедельник означал бы «открыть на прошлом дне».
          initialDate={todayIn(schedule.timezone)}
          timeZone={schedule.timezone}
          locale={ruLocale}
          firstDay={1}
          headerToolbar={false}
          allDaySlot={false}
          nowIndicator
          nowIndicatorLineClass="sc-now"
          nowIndicatorDotClass="sc-now-dot"
          expandRows
          height="100%"
          slotDuration={{ minutes: 30 }}
          snapDuration={{ minutes: SNAP_MINUTES }}
          slotHeaderInterval={{ hours: 1 }}
          // «09:00», а не «9»: час без минут читается как число, а не как время, и
          // на оси рядом с записями это сбивает.
          slotHeaderFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
          eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
          // В карточке только НАЧАЛО: конец виден по высоте самой карточки, а
          // «11:00 – 12:00» рядом с названием переносит его на вторую строку и
          // обрезает на полуслове.
          displayEventEnd={false}
          // Сутки показываются НЕ ЦЕЛИКОМ: двадцать четыре часа, из которых заняты
          // восемь, — это полотно, где приём приходится искать прокруткой. Границы
          // берутся из самого расписания и расширяются на час в каждую сторону,
          // чтобы соседний час был виден и на него можно было протянуть окно.
          slotMinTime={hours.min}
          slotMaxTime={hours.max}
          dayMaxEvents={3}
          slotHeaderContent={(info) => <span className="sc-slot-label">{info.text}</span>}
          dayCellTopContent={(info) => (
            <span className={`sc-cell-num${info.isToday ? ' sc-cell-today' : ''}`}>
              {info.text}
            </span>
          )}
          dayHeaderContent={(info) => (
            <span className={`sc-day-head${info.isToday ? ' sc-day-today' : ''}`}>
              <span className="sc-day-name">{info.weekdayText}</span>
              <span className="sc-day-num">{info.dayNumberText}</span>
            </span>
          )}
          // В МЕСЯЦЕ полос приёма нет — там их было бы тридцать штук, и клетка
          // превратилась бы в кашу. Вместо них приглушается день, в который приёма
          // нет вовсе: «работаю — не работаю» иначе не видно ничем.
          dayCellClass={(info) =>
            workingDays.has(dateKeyOf(info.date, schedule.timezone)) ? '' : 'sc-day-off'
          }
          eventContent={eventContent}
          // ⚠ СОСТОЯНИЕ СТАВИТСЯ ОТЛОЖЕННО, И ЭТО НЕ ПЕРЕСТРАХОВКА. `datesSet`
          // библиотека дёргает из обработчика смены своих пропсов, то есть ИЗ СВОЕЙ
          // ФАЗЫ РЕНДЕРА; setState оттуда React считает побочным эффектом рендера и
          // ругается в консоль («Can't perform a React state update on a component
          // that hasn't mounted yet», отчёт владельца 2026-09-04 — вылезало при сдвиге
          // линии текущего времени, когда библиотека перерисовывает себя сама).
          // Микрозадача выносит обновление за пределы рендера, ничего не откладывая
          // на глаз: она выполняется до следующей отрисовки.
          //
          // Значение сравнивается со старым: перерисовка библиотеки не меняет
          // показанный отрезок, и без этой проверки каждый тик линии времени
          // перерисовывал бы полотно целиком.
          datesSet={(info) => {
            const nextFirst = dateOfNaive(info.startStr)
            const nextDays = daysBetween(info.startStr, info.endStr)
            const nextView = info.view.type as ViewName
            queueMicrotask(() => {
              setFirstDate((prev) => (prev === nextFirst ? prev : nextFirst))
              setVisibleDays((prev) => (prev === nextDays ? prev : nextDays))
              setView((prev) => (prev === nextView ? prev : nextView))
            })
          }}
          selectable
          // МИРАЖ ВЫДЕЛЕНИЯ ВЫКЛЮЧЕН. Он рисует ту самую непрерывную кляксу «остаток
          // первого дня, средние дни целиком, начало последнего» — и рисует её ПОВЕРХ
          // подсказки, которую мы выправили в прямоугольник. Двух предпросмотров у
          // одного жеста быть не должно; остаётся подсказка (highlightClass).
          selectMirror={false}
          highlightClass="sc-hl"
          dayLaneClass="sc-lane"
          // ПОДСКАЗКА ВО ВРЕМЯ ПРОТЯЖКИ — тоже прямоугольник. Библиотека рисует
          // непрерывный отрезок (остаток первого дня, средние дни целиком, начало
          // последнего), и до правки автор видел одно, а получал другое. Хука на кадр
          // перетаскивания у неё нет; selectAllow — единственное, что вызывается на
          // каждое движение мыши, поэтому пересчёт живёт здесь. Значение всегда
          // истинно: этот обработчик ничего не запрещает.
          selectAllow={(span) => {
            paintBand(span.startStr, span.endStr)
            return true
          }}
          unselect={() => clearBand()}
          editable
          eventDurationEditable
          eventStartEditable
          // Записи не двигаются мышью: их время — договорённость с человеком, а не
          // настройка. Меняется оно отменой и новой записью, а не перетаскиванием.
          eventOverlap
          events={events}
          eventClass={eventClass}
          select={(info) => {
            // Протяжка на соседнюю колонку — ПРЯМОУГОЛЬНИК: те же часы на каждом
            // задетом дне, а не непрерывный отрезок «остаток вторника плюс начало
            // среды» (canvas.ts, selectionRect).
            // ⚠ ВЫДЕЛЕНИЕ СНИМАЕТСЯ СРАЗУ. Иначе библиотека оставляет на полотне свой
            // мираж — непрерывный отрезок «остаток понедельника, вторник целиком, среда
            // до 19:00», — и он остаётся висеть поверх созданных окон, показывая ровно
            // то, чего мы не делали.
            info.view.calendar.unselect()
            clearBand()
            const rect = selectionRect(info.startStr, info.endStr)
            if (!rect) return
            runGesture({ kind: 'create', ...rect }, pointOf(info.jsEvent), rect.dates)
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
            runGesture(gesture, pointOf(info.jsEvent), [date])
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
              [props.date],
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

      <CancelBookingDialog
        booking={cancelling}
        timezone={schedule.timezone}
        pending={cancel.isPending}
        error={cancel.isError ? humanError(cancel.error) : null}
        onClose={() => {
          cancel.reset()
          setCancelling(null)
        }}
        onConfirm={(booking) =>
          cancel.mutate(booking.id, {
            onSuccess: () => setCancelling(null),
          })
        }
      />

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
        onOpenSubmission={onOpenSubmission}
        onCancelBooking={setCancelling}
        onRemoveBlock={(id) => {
          removeBlock.mutate(id, { onError: (e) => setError(humanError(e)) })
          setAnchor(null)
        }}
      />
    </div>
  )

  // paintBand — переписать позицию подсказки под прямоугольник. Обёртки подсказки
  // позиционируются inline (`top`/`height` в пикселях), поэтому переопределяет их
  // правило с `!important`, читающее эти две переменные (canvas.css).
  //
  // Пиксели, а не проценты: колонка — это ровно ось часов, и её высота меряется по
  // месту. Считать проценты от времени пришлось бы, зная, что колонка нигде не
  // обрезана; замер честнее.
  function paintBand(startStr: string, endStr: string) {
    const el = canvasRef.current
    if (!el) return
    const rect = selectionRect(startStr, endStr)
    const lane = el.querySelector('.sc-lane')
    // Один день библиотека и так рисует верно — переписывать нечего.
    if (!rect || rect.dates.length < 2 || !lane) {
      clearBand()
      return
    }
    const box = bandBox(rect.window, hours, lane.clientHeight)
    if (!box) {
      clearBand()
      return
    }
    el.style.setProperty('--sc-band-top', `${box.top}px`)
    el.style.setProperty('--sc-band-h', `${box.height}px`)
    el.dataset.scBand = ''
  }

  function clearBand() {
    delete canvasRef.current?.dataset.scBand
  }

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

// CancelBookingDialog — подтверждение отмены записи.
//
// ОТМЕНА НЕОБРАТИМА И ЗАДЕВАЕТ ЧУЖОГО ЧЕЛОВЕКА, поэтому спрашивается диалогом
// (отчёт владельца 2026-09-04: подтверждения не было вовсе). Диалог говорит обе
// стороны последствия: место вернётся в оборот, а записавшемуся уйдёт письмо,
// которое гасит встречу и в его календаре.
//
// ⚠ ПРО ПИСЬМО ГОВОРИТСЯ ЧЕСТНО. Адрес живёт в ОТВЕТЕ формы, и если ответ удалён,
// слать письмо некуда — тогда диалог прямо просит сообщить человеку самому. Обещать
// письмо там, где его не будет, — худший вид молчания: автор считает, что клиент
// предупреждён.
//
// Диалог закрывается только по успеху: отказ сервера иначе остался бы за уже
// закрытым окном, а место выглядело бы освобождённым.
function CancelBookingDialog({
  booking,
  timezone,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  booking: Booking | null
  timezone: string
  pending: boolean
  error: string | null
  onClose: () => void
  onConfirm: (booking: Booking) => void
}) {
  return (
    <AlertDialog open={booking !== null} onOpenChange={(open) => !open && onClose()}>
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
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Оставить</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={(e) => {
                  // Окно закрывается САМО по успеху, а не по клику.
                  e.preventDefault()
                  onConfirm(booking)
                }}
              >
                {pending ? 'Отменяем…' : 'Отменить запись'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

// bookingWhen — «4 сентября, 11:00» в поясе расписания.
function bookingWhen(booking: Booking, timeZone: string): string {
  return new Date(booking.startsAt).toLocaleString(LOCALE, {
    timeZone,
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
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
  const props = info.event.extendedProps as EventProps | undefined
  // ⚠ СОБЫТИЕ БЕЗ СЛОЯ — ЧУЖОЕ: мираж перетаскивания, который библиотека рисует сама.
  // До правки оно проваливалось в ветку записи и вылезало на полотне синей кляксой
  // (отчёт владельца 2026-09-04). Своего вида у чужого события быть не должно.
  if (!props?.layer) return 'sc-ev sc-ghost'
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

function Legend({ className, title }: { className: string; title: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`sc-key ${className}`} aria-hidden />
      {title}
    </span>
  )
}

// VIEWS — три вида полотна. Месяц отвечает на вопрос «когда я вообще работаю»,
// неделя — «как устроен распорядок», день — «что сегодня» и он же единственный
// читаемый на телефоне.
const VIEWS = [
  { name: 'dayGridMonth', title: 'Месяц' },
  { name: 'timeGridWeek', title: 'Неделя' },
  { name: 'timeGridDay', title: 'День' },
] as const

type ViewName = (typeof VIEWS)[number]['name']

// axisHours — границы оси часов. Сутки целиком показывать нельзя: приём занимает в
// них треть, и его пришлось бы искать прокруткой. Час запаса с каждой стороны — не
// красота: без него окно приёма прижато к краю, и протянуть новое рядом некуда.
function axisHours(
  schedule: Schedule,
  dates: string[],
  busy: { blocks: ScheduleBlock[]; bookings: Booking[] } | undefined,
): { min: string; max: string } {
  const clocks: number[] = []
  for (const date of dates) {
    for (const w of effectiveWindows(schedule.availability, date).windows) {
      const from = clockToMinutes(w.from)
      const to = clockToMinutes(w.to)
      if (from !== null) clocks.push(from)
      if (to !== null) clocks.push(to)
    }
  }
  const busyAt = (iso: string) => clockToMinutes(zonedParts(new Date(iso), schedule.timezone).clock)
  for (const b of busy?.blocks ?? []) {
    const from = busyAt(b.startsAt)
    const to = busyAt(b.endsAt)
    if (from !== null) clocks.push(from)
    if (to !== null) clocks.push(to)
  }
  for (const b of busy?.bookings ?? []) {
    const from = busyAt(b.startsAt)
    if (from !== null) clocks.push(from, from + b.durationMinutes)
  }
  // Пустое расписание показывает рабочий день, а не полночь-полночь: полотно, на
  // котором ещё ничего нет, должно открываться там, где приём заводят.
  const min = clocks.length > 0 ? Math.min(...clocks, 9 * 60) : 8 * 60
  const max = clocks.length > 0 ? Math.max(...clocks, 18 * 60) : 20 * 60
  return {
    min: minutesToClock(Math.max(0, Math.floor((min - 60) / 60) * 60)),
    max: minutesToClock(Math.min(24 * 60, Math.ceil((max + 60) / 60) * 60)),
  }
}

// dateKeyOf — календарная дата момента В ПОЯСЕ РАСПИСАНИЯ: клетка месяца приходит
// от библиотеки моментом, а «работаю ли я в этот день» спрашивается у правила,
// которое живёт в местном времени.
function dateKeyOf(at: Date, timeZone: string): string {
  return zonedParts(at, timeZone).date
}

// eventContent — своя отрисовка вместо библиотечной: у трёх слоёв разный смысл, и
// одинаковая строка «10:00 Название» у всех троих их бы уравняла.
function eventContent(info: {
  event: { extendedProps: Record<string, unknown>; title: string }
  timeText: string
}) {
  const props = info.event.extendedProps as EventProps | undefined
  if (!props?.layer) return null
  if (props.layer === 'availability') {
    // Полоса приёма БЕЗ ТЕКСТА: это фон дня, а не событие. Что означает цвет,
    // говорит легенда под панелью — надпись в каждой полосе повторяла бы её
    // семь раз на экран.
    return <span className="sc-av-fill" />
  }
  return (
    <span className="sc-ev-short">
      <span className="sc-ev-time">{info.timeText}</span>
      <span className="sc-ev-title">{info.event.title}</span>
    </span>
  )
}

// rangeTitle — что за отрезок показан: «14 — 20 сентября», «сентябрь 2026»,
// «16 сентября». Не «неделя 38»: номерами недель у нас никто не живёт.
function rangeTitle(dates: string[], view: ViewName): string {
  const first = dates[0]
  const last = dates[dates.length - 1]
  if (!first || !last) return ''
  if (view === 'dayGridMonth') {
    // У месяца в отрезок попадают хвосты соседних месяцев, поэтому имя берётся у
    // середины, а не у первой клетки: иначе сентябрь назывался бы августом.
    const middle = dates[Math.floor(dates.length / 2)] ?? first
    return capitalize(
      new Date(`${middle}T00:00:00Z`).toLocaleDateString(LOCALE, {
        timeZone: 'UTC',
        month: 'long',
        year: 'numeric',
      }),
    )
  }
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

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
