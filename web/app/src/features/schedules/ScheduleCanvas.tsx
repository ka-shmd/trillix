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

import type {
  Availability,
  Booking,
  Schedule,
  ScheduleBlock,
  ScheduleInput,
  TimeWindow,
} from '../../entities/schedule'
import {
  calendarQueryOptions,
  useAddBlock,
  useRemoveBlock,
  useUpdateSchedule,
} from '../../shared/schedules/queries'
import { Button } from '@/components/ui/button'
import { humanError } from '../../shared/api/errors'
import { LOCALE } from '../../shared/format'
import { clearBand as clearBandEl, paintBand as paintBandEl } from './band'
import {
  AXIS,
  clockOfNaive,
  dateByNumber,
  dateKeys,
  dateOfNaive,
  effectiveWindows,
  scrollStart,
  selectionRect,
  shiftDate,
  spansIn,
  weekStart,
  windowOf,
  type AvailabilitySpan,
} from './canvas'
import {
  applyGesture,
  closeDay,
  dayState,
  docError,
  resetDay,
  snapToGrid,
  SNAP_MINUTES,
  type Gesture,
} from './canvasEdit'
import { clockToMinutes, minutesToClock } from './weekly'
import { MoveBookingDialog } from './MoveBookingDialog'
import { CanvasPopover, type Anchor } from './CanvasPopover'
import { DayHeader } from './DayHeader'
import { formTone } from './formColor'
import { WindowPopover, type WindowAnchor } from './WindowPopover'
import { SurfaceTabs, type Surface } from './SurfaceTabs'
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
  surface,
  onSurface,
  goToDate,
  onRange,
  onOpenSubmission,
  onCancelBooking,
}: {
  schedule: Schedule
  // Поверхность и её переключатель приезжают СО СТРАНИЦЫ: от выбора зависит не
  // только полотно, но и левая полоса — там мини-календарь сменяется сводкой
  // правила, — а значит решать это полотну не по чину.
  surface: Surface
  onSurface: (s: Surface) => void
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
  // Отмена тоже спрашивается СТРАНИЦЕЙ: тот же диалог открывается из списка
  // ближайших записей слева, и два его экземпляра — это два разных обещания на одно
  // действие.
  onCancelBooking: (booking: Booking) => void
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
  // Окно приёма спрашивается ОТДЕЛЬНЫМ попапом: тот же вопрос задаёт поверхность
  // «Приём», и два его экземпляра были бы двумя обещаниями на одно действие.
  const [windowAnchor, setWindowAnchor] = useState<WindowAnchor | null>(null)
  const [error, setError] = useState<string | null>(null)
  // ДЕНЬ, У КОТОРОГО ПРАВЯТ ЧАСЫ. Пока он назван, его подложка перестаёт быть
  // подложкой: окна этого дня становятся обычными событиями, их можно тянуть и
  // убирать, а протяжка по его колонке заводит приём, а не занятость. Остальные дни
  // в это время живут как обычно.
  const [editingDay, setEditingDay] = useState<string | null>(null)
  // ПЕРЕНОС ЗАПИСИ ждёт подтверждения: карточка в полотне уже переехала, а в базе
  // нет. `revert` — обещание библиотеки вернуть её на место; без него отказ и
  // «оставить как было» оставляли бы на экране встречу, которой не случилось.
  const [moving, setMoving] = useState<{ booking: Booking; startsAt: string } | null>(null)
  const revertMove = useRef<(() => void) | null>(null)
  // Контейнер нужен ИМПЕРАТИВНО: подсказка перерисовывается на каждое движение мыши,
  // и гонять через состояние React перерисовку всего полотна на каждый кадр —
  // заведомо рвано.
  const canvasRef = useRef<HTMLDivElement>(null)
  // Календарь целиком — ради одного `unselect()`, которого нет у контроллера
  // (`useCalendarController` умеет листать и менять вид, но не снимать выделение).
  // Снять его нужно РОВНО ТОГДА, когда закрылся попап: до этого выделение — предмет
  // вопроса, и гасить его, пока спрашиваем, значит спрашивать про пустое место.
  const calendarRef = useRef<{ unselect: () => void } | null>(null)

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
  const addBlock = useAddBlock(schedule.id)
  const removeBlock = useRemoveBlock(schedule.id)

  const month = view === 'dayGridMonth'
  const events = useMemo(
    () => [
      // В месяце полос приёма нет: тридцать полос превратили бы клетки в кашу, а
      // «работаю — не работаю» там показывает приглушённый день (dayCellClass).
      ...(month
        ? []
        : spansIn(schedule.availability, dates).map((span) =>
            availabilityEvent(span, span.date === editingDay),
          )),
      ...(busy.data?.blocks ?? []).map(blockEvent),
      ...(busy.data?.bookings ?? []).map(bookingEvent),
    ],
    [schedule.availability, dates, busy.data, month, editingDay],
  )

  // Дни видимого отрезка, в которые приём вообще ведётся, — месяцу.
  const workingDays = useMemo(
    () =>
      new Set(dates.filter((d) => effectiveWindows(schedule.availability, d).windows.length > 0)),
    [schedule.availability, dates],
  )

  // Куда прокручена сетка на открытии. Считается ОДИН РАЗ, при монтировании: пересчёт
  // на каждую правку правила дёргал бы полотно обратно к утру ровно в тот момент,
  // когда автор смотрит на вечер.
  const [scrollTo] = useState(() => scrollStart(schedule.availability))

  // saveAvailability — правка правила уходит на сервер СРАЗУ: полотно живёт по
  // законам календаря, а не формы с кнопкой «Сохранить». Параметры записи ниже по
  // странице сохраняются по-прежнему своей кнопкой — они не жест, а настройка.
  function saveAvailability(next: Availability) {
    const bad = docError(next)
    if (bad) {
      setError(bad)
      return
    }
    setError(null)
    update.mutate(toInput(schedule, next), { onError: (e) => setError(humanError(e)) })
  }

  // applyDay — жест в режиме правки часов одного дня. Область всегда `date`: на
  // этой поверхности правят КОНКРЕТНОЕ число, а «пусть так будет всегда» живёт на
  // соседней вкладке и правится там же.
  function applyDay(gesture: Gesture) {
    saveAvailability(applyGesture(schedule.availability, gesture, 'date'))
  }

  // closePopover — закрыть попап И снять выделение.
  function closePopover() {
    calendarRef.current?.unselect()
    clearBand()
    setAnchor(null)
  }

  // closeTime — ЕДИНСТВЕННЫЙ смысл протяжки по датированной неделе: это время
  // занято. Слой здесь известен по построению — часы приёма стали подложкой, и
  // нарисовать их этим жестом нельзя (ADR §10).
  function closeTime(rect: { dates: string[]; window: TimeWindow }) {
    // По блокировке на каждый задетый день: занятое время — точки на оси, и одной
    // строкой «со вторника по четверг» они не выражаются (иначе закрытой оказалась бы
    // и ночь между днями).
    for (const date of rect.dates) {
      addBlock.mutate(
        {
          startsAt: zonedToUTC(date, rect.window.from, schedule.timezone),
          endsAt: zonedToUTC(date, endClock(rect.window.to), schedule.timezone),
          note: '',
        },
        { onError: (e) => setError(humanError(e)) },
      )
    }
  }

  return (
    // Полотно занимает ВСЮ высоту отведённой панели: панель управления и легенда
    // сверху не растягиваются, а сетка забирает остаток (min-h-0 обязателен — без
    // него flex-элемент не сжимается ниже содержимого, и сетка вылезает за экран).
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-1">
          {/* Переключатель поверхностей стоит ПЕРВЫМ и на обеих вкладках на одном
              месте: орган управления, прыгающий под курсором от собственного
              нажатия, — это второй орган управления. */}
          <SurfaceTabs surface={surface} onSurface={onSurface} />
          <span className="mx-2 h-5 w-px bg-border" aria-hidden />
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
          // СУТКИ ЦЕЛИКОМ (решение владельца 2026-09-04). Ось, обрезанная по часам
          // приёма, отвечала не на тот вопрос: она показывала, что уже настроено, и
          // ровно этим не давала настроить остальное — ночную смену, ранний час,
          // встречу до открытия приёма. Открывается сетка всё равно на рабочих
          // часах (scrollTime), но остаток суток от неё в одном движении колеса.
          slotMinTime={AXIS.min}
          slotMaxTime={AXIS.max}
          scrollTime={scrollTo}
          // В клетку месяца влезает три записи, остальные прячутся за «ещё N» —
          // окном, которое библиотека рисует сама. Своей палитры у него нет (тему мы
          // подключаем без неё), поэтому вид ему задан классами ниже: без них окно
          // выходило прозрачным, и сквозь него просвечивала сама клетка.
          dayMaxEvents={3}
          // ⚠ ОКНО ЖИВЁТ В ПОРТАЛЕ, ЗА ПРЕДЕЛАМИ КОНТЕЙНЕРА ПОЛОТНА, поэтому носит
          // `sc-canvas` вторым классом: все правила вида — цвета слоёв, шрифт,
          // разметка события — писаны от него, и без этого записи в окне остались бы
          // голым текстом с точкой.
          popoverClass="sc-canvas sc-pop"
          popoverCloseClass="sc-pop-close"
          slotHeaderContent={(info) => <span className="sc-slot-label">{info.text}</span>}
          dayCellTopContent={(info) => (
            <span className={`sc-cell-num${info.isToday ? ' sc-cell-today' : ''}`}>
              {info.text}
            </span>
          )}
          dayHeaderContent={(info) => {
            // В ОКНЕ «ещё N» шапка — заголовок окна, а не колонка недели: нужна
            // полная дата, а наша разметка колонки дала бы там одинокое число без
            // месяца (имя дня в этом месте библиотека не считает).
            if (info.inPopover) return <span className="sc-pop-title">{info.text}</span>
            // В МЕСЯЦЕ шапка называет день недели, а не дату: колонок семь, а клеток
            // тридцать, и меню исключений вешать не на что.
            if (month) {
              return (
                <span className="sc-day-head">
                  <span className="sc-day-name">{info.weekdayText}</span>
                </span>
              )
            }
            // ⚠ ДАТА КОЛОНКИ — ПО ЧИСЛУ В ЕЁ ШАПКЕ, а не по `info.date`. У Date
            // библиотеки в именованном поясе двойное прочтение: это может быть и
            // настоящий момент начала суток, и «маркер», у которого UTC-поля хранят
            // местное время. Два прочтения расходятся на сутки при ОТРИЦАТЕЛЬНОМ
            // смещении пояса, и «не принимаю в этот день» закрыло бы соседний.
            // Число же однозначно: в видимом отрезке (семь дней или один) оно
            // встречается ровно раз.
            const date = dateByNumber(dates, info.dayNumberText)
            if (!date) return null
            return (
              <DayHeader
                name={info.weekdayText}
                number={info.dayNumberText}
                today={info.isToday}
                state={dayState(schedule.availability, date)}
                editing={editingDay === date}
                onCloseDay={() => saveAvailability(closeDay(schedule.availability, date))}
                onEditHours={() => setEditingDay((d) => (d === date ? null : date))}
                onResetDay={() => {
                  saveAvailability(resetDay(schedule.availability, date))
                  setEditingDay((d) => (d === date ? null : d))
                }}
              />
            )
          }}
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
          // Клик по попапу выделение НЕ СНИМАЕТ: по умолчанию библиотека гасит его от
          // любого нажатия за пределами сетки, а попап живёт в портале вне её — и
          // подсказка исчезала бы от первого же ответа на вопрос.
          unselectCancel='[data-slot="popover-content"]'
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
            calendarRef.current = info.view.calendar
            // Протяжка на соседнюю колонку — ПРЯМОУГОЛЬНИК: те же часы на каждом
            // задетом дне, а не непрерывный отрезок «остаток вторника плюс начало
            // среды» (canvas.ts, selectionRect).
            const rect = selectionRect(info.startStr, info.endStr)
            info.view.calendar.unselect()
            clearBand()
            if (!rect) return
            // ЖЕСТ ПРИМЕНЯЕТСЯ СРАЗУ И БЕЗ ВОПРОСОВ: что за время размечено, здесь
            // известно по построению. Обычно это занятость — часы приёма на этой
            // поверхности подложка, и нарисовать их нельзя; исключение одно —
            // колонка дня, часы которого правят прямо сейчас.
            if (editingDay && rect.dates.length === 1 && rect.dates[0] === editingDay) {
              applyDay({ kind: 'create', dates: rect.dates, window: rect.window })
              return
            }
            closeTime(rect)
          }}
          // eventAllow — окно приёма не уходит из своей колонки. Перетащить его на
          // соседний день значило бы «в среду принимаю как во вторник», а это правка
          // ПРАВИЛА, и живёт она на поверхности «Приём».
          eventAllow={(drop, event) => {
            const props = event?.extendedProps as EventProps | undefined
            if (props?.layer !== 'availability') return true
            return dateOfNaive(drop.startStr) === props.date
          }}
          eventDrop={(info) => {
            const props = info.event.extendedProps as EventProps
            if (props.layer === 'block') {
              moveBlock(props.block, info.event.startStr, info.event.endStr)
              return
            }
            if (props.layer === 'booking') {
              askMove(props.booking, info.event.startStr, info.revert)
              return
            }
            // Окна приёма двигаются только в режиме правки дня: в остальное время
            // они подложка, и библиотека сюда не доводит.
            if (props.layer !== 'availability' || !info.event.startStr) return
            applyDay({
              kind: 'update',
              date: props.date,
              orig: props.window,
              window: windowOf(info.event.startStr, info.event.endStr),
            })
          }}
          eventResize={(info) => {
            const props = info.event.extendedProps as EventProps
            if (props.layer === 'block') {
              moveBlock(props.block, info.event.startStr, info.event.endStr)
              return
            }
            if (props.layer !== 'availability') return
            applyDay({
              kind: 'update',
              date: props.date,
              orig: props.window,
              window: windowOf(info.event.startStr, info.event.endStr),
            })
          }}
          eventClick={(info) => {
            const props = info.event.extendedProps as EventProps
            const at = pointOf(info.jsEvent)
            if (props.layer === 'availability') {
              setWindowAnchor({ ...at, date: props.date, window: props.window })
            } else if (props.layer === 'block') {
              setAnchor({ ...at, kind: 'block', block: props.block })
            } else {
              setAnchor({ ...at, kind: 'booking', booking: props.booking })
            }
          }}
        />
      </div>

      <WindowPopover
        anchor={windowAnchor}
        title="Убрать приём в этот день"
        onClose={() => setWindowAnchor(null)}
        onRemove={(date, w) => {
          applyDay({ kind: 'remove', date, orig: w })
          setWindowAnchor(null)
        }}
      />

      <MoveBookingDialog
        scheduleId={schedule.id}
        move={moving}
        timezone={schedule.timezone}
        outsideHours={moving !== null && !insideHours(schedule, moving.startsAt)}
        onClose={finishMove}
      />

      <CanvasPopover
        anchor={anchor}
        schedule={schedule}
        onClose={closePopover}
        onOpenSubmission={onOpenSubmission}
        onCancelBooking={onCancelBooking}
        onRemoveBlock={(id) => {
          removeBlock.mutate(id, { onError: (e) => setError(humanError(e)) })
          closePopover()
        }}
      />
    </div>
  )

  // Подсказка протяжки живёт в band.ts — её рисуют обе поверхности полотна.
  function paintBand(startStr: string, endStr: string) {
    paintBandEl(canvasRef.current, startStr, endStr)
  }

  function clearBand() {
    clearBandEl(canvasRef.current)
  }

  // askMove — карточку бросили, спрашиваем подтверждение.
  //
  // ⚠ ВРЕМЯ ПРИЛИПАЕТ К СЕТКЕ ЗДЕСЬ, а не на сервере: занятость слота считается по
  // равенству точки старта, и промах в семь минут сервер отвергнет 422-й. Липкость
  // (canvasEdit, snapToGrid) — зеркало доменного правила, поэтому диалог называет
  // ровно то время, которое уедет.
  function askMove(booking: Booking, startStr: string, revert: () => void) {
    const date = dateOfNaive(startStr)
    const dropped = clockToMinutes(clockOfNaive(startStr))
    if (dropped === null) {
      revert()
      return
    }
    const step = schedule.slotMinutes + schedule.bufferMinutes
    const at = snapToGrid(schedule.availability, date, dropped, step)
    revertMove.current = revert
    setMoving({ booking, startsAt: zonedToUTC(date, minutesToClock(at), schedule.timezone) })
  }

  // finishMove — исход диалога. Отказавшись, карточку ОБЯЗАТЕЛЬНО возвращаем: полотно
  // её уже передвинуло, а данные не менялись, и сама она назад не поедет.
  function finishMove(moved: boolean) {
    if (!moved) revertMove.current?.()
    revertMove.current = null
    setMoving(null)
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

// EventProps — что полотно знает о своём событии. Слой обязателен: обработчики
// приходят одни на все четыре, и различать их по виду события нечем.
type EventProps =
  | {
      layer: 'availability'
      date: string
      window: TimeWindow
      source: string
      // editing — окно принадлежит дню, часы которого правят прямо сейчас. Лежит в
      // самом событии, потому что вид красит `eventClass`, а до состояния экрана он
      // не дотягивается.
      editing: boolean
    }
  | { layer: 'block'; block: ScheduleBlock }
  | { layer: 'booking'; booking: Booking }

// ЧАСЫ ПРИЁМА — ФОНОВОЕ СОБЫТИЕ, а не обычное (ADR §10). Фоновое библиотека не даёт
// ни двигать, ни тянуть, ни нажимать — ровно то, чем подложка и должна быть на этой
// поверхности: правило правится на соседней вкладке.
//
// Исключение одно — день, часы которого правят прямо сейчас: на время режима его
// окна возвращаются в обычные события и обретают ручки.
function availabilityEvent(span: AvailabilitySpan, editing: boolean) {
  return {
    id: `av:${span.date}:${span.window.from}-${span.window.to}`,
    start: span.start,
    end: span.end,
    display: editing ? 'auto' : 'background',
    extendedProps: {
      layer: 'availability',
      date: span.date,
      window: span.window,
      source: span.source,
      editing,
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
    // ЗАПИСЬ ДВИГАЕТСЯ, НО НЕ ТЯНЕТСЯ. Перенести встречу автор вправе — это его
    // рабочий стол; изменить её длительность нельзя: она снимок нарезки на момент
    // записи (0050), и растягивать чужую встречу мышью значило бы менять
    // договорённость молча.
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
    const source = props.source === 'exception' ? 'sc-av-ex' : 'sc-av-weekly'
    // Правимый день выделен и на самой полосе: режим, который виден только по
    // открытому меню, автор забудет закрыть.
    return `sc-ev sc-av ${source}${props.editing ? ' sc-av-edit' : ''}`
  }
  if (props.layer === 'block') return 'sc-ev sc-block'
  // ЦВЕТ ЗАПИСИ — ЧЬЯ ЭТО ФОРМА, тем же набором и тем же способом, что в списке
  // ближайших (formColor.ts): одно расписание обслуживает несколько форм, и на
  // полотне они шли вперемешку одним цветом.
  return `sc-ev sc-booking ${formTone(props.booking.formId)}`
}

// endClock — «24:00» в отметку, которую понимает перевод в UTC.
function endClock(to: string): string {
  return to === '24:00' ? '23:59' : to
}

function pointOf(e: MouseEvent | null): { x: number; y: number } {
  return { x: e?.clientX ?? 0, y: e?.clientY ?? 0 }
}

// toInput — расписание в тело PATCH. Перечислением, а не выбрасыванием служебных
// полей: новое поле обязано попасть сюда осознанно, иначе правка полотна молча
// сбрасывала бы его к прежнему значению.
function toInput(s: Schedule, availability: Availability): ScheduleInput {
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

// insideHours — лежит ли эта точка внутри часов приёма. Отказом это не является
// (автор вправе поставить человека и вне приёма), но диалог обязан сказать об этом
// вслух: время вне приёма формой не предлагается, и вернуть его в оборот отменой уже
// не выйдет.
function insideHours(schedule: Schedule, iso: string): boolean {
  const { date, clock } = zonedParts(new Date(iso), schedule.timezone)
  const minutes = clockToMinutes(clock)
  if (minutes === null) return false
  return effectiveWindows(schedule.availability, date).windows.some((w) => {
    const from = clockToMinutes(w.from)
    const to = clockToMinutes(w.to)
    return from !== null && to !== null && minutes >= from && minutes < to
  })
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
