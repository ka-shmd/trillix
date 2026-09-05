import { ChevronDown } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Шапка колонки дня на поверхности «Календарь» — она же вход в исключения по датам.
//
// ИСКЛЮЧЕНИЯ ДЕЛЯТСЯ НАДВОЕ ЧЕСТНО. «Не принимаю 14-го» — отпуск, праздник, уехал —
// это девять случаев из десяти, и стоит оно одного нажатия. «В этот день принимаю
// иначе» случается редко и требует правки часов, поэтому включает режим, в котором
// подложка этого дня на время становится редактируемой.
//
// Меню висит на самой шапке, а не на отдельном значке: у колонки один заголовок, и
// второй орган управления рядом с ним читался бы как что-то ещё.
export type DayState = 'weekly' | 'exception' | 'closed'

export function DayHeader({
  name,
  number,
  today,
  state,
  editing,
  onCloseDay,
  onEditHours,
  onResetDay,
}: {
  name: string
  number: string
  today: boolean
  state: DayState
  // editing — у этого дня прямо сейчас правят часы. Меню тогда предлагает выход, а
  // не вход: режим, из которого не видно выхода, — ловушка.
  editing: boolean
  onCloseDay: () => void
  onEditHours: () => void
  onResetDay: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`sc-day-head sc-day-menu${today ? ' sc-day-today' : ''}${
            state === 'weekly' ? '' : ' sc-day-special'
          }`}
        >
          <span className="sc-day-name">
            {name}
            <ChevronDown className="sc-day-chevron" aria-hidden />
          </span>
          <span className="sc-day-num">{number}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        {editing ? (
          <DropdownMenuItem onSelect={onEditHours}>Готово</DropdownMenuItem>
        ) : (
          <>
            {state !== 'closed' && (
              <DropdownMenuItem onSelect={onCloseDay}>Не принимаю в этот день</DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onEditHours}>Изменить часы этого дня</DropdownMenuItem>
          </>
        )}
        {/* «Как обычно» есть только там, где обычное уже перебито: пункт, снимающий
            то, чего нет, — это обещание действия без действия. */}
        {state !== 'weekly' && (
          <DropdownMenuItem onSelect={onResetDay}>Принимаю как обычно</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
