import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarClock, MoreHorizontal } from 'lucide-react'

import { type Booking, type Schedule } from '../../entities/schedule'
import { bookingsQueryOptions } from '../../shared/schedules/queries'
import { LazyCalendar } from '../../shared/lazyCalendar'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { bookingTime } from './scheduleFormat'
import { formInk, formTint } from './formColor'
import { zonedParts } from './zone'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Левая полоса страницы расписания: мини-календарь и ближайшие записи.
//
// МИНИ-КАЛЕНДАРЬ — `react-day-picker`, а не второй экземпляр FullCalendar. Своего
// компонента-выбиралки у FullCalendar нет вовсе; месячный вид в роли выбиралки — это
// целый календарный движок ради семи колонок, со своей темой, своими размерами и
// собственным представлением о том, что такое клик по дню. `react-day-picker` в
// кабинете уже узаконен ровно под это (web/CLAUDE.md) и приезжает тем же ленивым
// чанком, что и выбор даты закрытия формы.
export function SchedulePanel({
  schedule,
  visible,
  onPick,
  onOpenSubmission,
  onCancelBooking,
}: {
  schedule: Schedule
  // visible — дни, показанные полотном справа. Подсвечиваются в мини-календаре: две
  // половины экрана обязаны говорить об одной и той же неделе.
  visible: string[]
  onPick: (date: string) => void
  // Окно ответа и диалог отмены рисует СТРАНИЦА: окно принадлежит фиче ответов
  // (импорт фичи из фичи запрещён), а диалог отмены — общий с полотном.
  onOpenSubmission: (booking: Booking) => void
  onCancelBooking: (booking: Booking) => void
}) {
  // Месяц мини-календаря — своё состояние: автор листает его, разглядывая даты, и
  // полотно при этом стоять на месте обязано. Прыгает оно только по клику на день.
  const [month, setMonth] = useState<Date | undefined>(undefined)

  const range = useMemo(() => visible.map(asLocalDate), [visible])
  const first = range[0]
  const last = range[range.length - 1]

  return (
    <div className="flex flex-col gap-4">
      <LazyCalendar
        mode="single"
        required={false}
        selected={first}
        month={month ?? first}
        onMonthChange={setMonth}
        onSelect={(day) => day && onPick(dateKeyOfLocal(day))}
        // Показанный отрезок подсвечен целиком, а выбранным считается его первый
        // день: иначе неделя на полотне и точка в календаре расходятся, и автор
        // ищет глазами, где он вообще находится.
        modifiers={{ shown: first && last ? { from: first, to: last } : [] }}
        modifiersClassNames={{ shown: 'bg-accent text-accent-foreground rounded-none' }}
        // СЕГОДНЯШНИЙ ДЕНЬ — ВТОРЫМ АКЦЕНТОМ (решение владельца 2026-09-04). Штатный
        // серый у него не отличался от подсветки показанного отрезка, и «сегодня»
        // терялось ровно в тот момент, когда автор ищет глазами, где он находится.
        // Второй акцент здесь на своём месте по роли: он метит ДЕТАЛЬ и ничего не
        // обещает (DESIGN-SYSTEM §6), а первый акцент в этом календаре уже занят —
        // им красится выбранный день.
        //
        // classNames перебивается пропом, поэтому вендоренный компонент не тронут:
        // правка в нём покрасила бы «сегодня» во всех календарях кабинета.
        classNames={{
          // Заливка и цвет числа задаются САМОЙ КНОПКЕ дня, а не клетке. Две причины,
          // и обе проверены глазами:
          //
          //  • цвет клетка передаёт по наследству, а день вне показанного месяца
          //    перебивает наследство приглушённым — на втором акценте выходило серое;
          //  • выбранный день красит кнопку акцентом правилом на класс+атрибут, и без
          //    `!` оно перебивало бы «сегодня» — а в виде дня сегодняшний день ВСЕГДА
          //    и выбранный, то есть второго акцента не было бы там, где он нужнее всего.
          today: 'rounded-md [&>button]:bg-highlight! [&>button]:text-highlight-foreground!',
        }}
        className="w-full p-0 [--cell-size:--spacing(8)]"
      />

      <div className="border-t pt-4">
        <UpcomingList
          schedule={schedule}
          onPick={onPick}
          onOpenSubmission={onOpenSubmission}
          onCancelBooking={onCancelBooking}
        />
      </div>
    </div>
  )
}

// UpcomingList — ближайшие записи полоской, а не разделом страницы: в правой части
// они и так видны на полотне, а здесь отвечают на вопрос «кто ближайший» без
// разглядывания сетки. Имени и контактов тут нет — они живут в ответе формы и
// подчиняются его правилам (152-ФЗ).
//
// ДЕЙСТВИЯ ТЕ ЖЕ, ЧТО У КАРТОЧКИ НА ПОЛОТНЕ (решение владельца 2026-09-04): открыть
// ответ и отменить запись. Список отвечает на вопрос «кто ближайший», и человек,
// получивший ответ, тут же и действует — уходить ради этого искать ту же запись в
// сетке незачем. Диалоги рисует страница: они общие со списком и полотном.
//
// Время — в поясе РАСПИСАНИЯ, а не браузера: распорядок задан в нём, и поездка автора
// не должна сдвигать ему показ собственного расписания.
function UpcomingList({
  schedule,
  onPick,
  onOpenSubmission,
  onCancelBooking,
}: {
  schedule: Schedule
  onPick: (date: string) => void
  onOpenSubmission: (booking: Booking) => void
  onCancelBooking: (booking: Booking) => void
}) {
  const bookings = useQuery(bookingsQueryOptions(schedule.id))

  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 text-sm font-semibold">Ближайшие записи</p>

      {bookings.isPending && <LoadingRows rows={2} />}
      {bookings.isError && (
        <ErrorState
          title="Не удалось загрузить записи."
          onRetry={() => void bookings.refetch()}
          retryLabel="Повторить"
        />
      )}

      {bookings.data?.length === 0 && (
        <EmptyState
          icon={CalendarClock}
          title="Записей пока нет"
          description="Как только к вам запишутся через форму, встреча появится здесь."
        />
      )}

      <ul className="flex flex-col gap-1">
        {bookings.data?.map((b) => (
          // ЦВЕТ — ЧЬЯ ЭТО ФОРМА (решение владельца 2026-09-04). Одно расписание
          // обслуживает несколько форм, и в списке они идут вперемешку: подложка и
          // полоска слева отвечают на «чья запись» без чтения. Название формы при
          // этом остаётся в строке — тонов восемь, и на девятой форме они
          // повторяются (formColor.ts).
          <li
            key={b.id}
            className="flex items-center gap-1 overflow-hidden rounded-md border-l-2 pr-1"
            style={{ background: formTint(b.formId), borderLeftColor: formInk(b.formId) }}
          >
            {/* Строка — КНОПКА: она листает полотно к своей дате, то есть это
                настоящее действие, а не подпись. */}
            <button
              type="button"
              className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
              onClick={() => onPick(zonedParts(new Date(b.startsAt), schedule.timezone).date)}
            >
              <span className="block text-sm font-medium">
                {bookingTime(b.startsAt, schedule.timezone)}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {b.formTitle}
                {b.seats > 1 && ` · мест: ${b.seats}`}
              </span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 shrink-0">
                  <MoreHorizontal className="size-4" />
                  <span className="sr-only">Действия с записью</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Ответ переживает не всегда: удалённый оставляет запись без ссылки,
                    и пункт остаётся на месте выключенным — исчезнув, он заставил бы
                    гадать, куда делся. */}
                <DropdownMenuItem disabled={!b.submissionId} onSelect={() => onOpenSubmission(b)}>
                  {b.submissionId ? 'Открыть ответ' : 'Ответ удалён'}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => onCancelBooking(b)}>
                  Отменить запись
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
    </div>
  )
}

// asLocalDate / dateKeyOfLocal — мост между ключом даты (ГГГГ-ММ-ДД, как живёт
// правило) и Date, которым мини-календарь думает. Через МЕСТНУЮ полночь браузера, а
// не UTC: `react-day-picker` сравнивает дни местными методами, и дата, собранная в
// UTC, в поясах западнее Гринвича показывалась бы предыдущим днём.
function asLocalDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

function dateKeyOfLocal(at: Date): string {
  const m = String(at.getMonth() + 1).padStart(2, '0')
  const d = String(at.getDate()).padStart(2, '0')
  return `${at.getFullYear()}-${m}-${d}`
}
