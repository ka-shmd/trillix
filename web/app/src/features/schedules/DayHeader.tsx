import { ChevronDown } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Шапка колонки дня — она же вход в исключения по датам.
//
// ЗДЕСЬ ТОЛЬКО САМЫЙ ЧАСТЫЙ СЛУЧАЙ. «Не принимаю 14-го» — отпуск, праздник, уехал —
// это девять исключений из десяти, и стоит оно одного нажатия. «В этот день принимаю
// иначе» делается той же протяжкой по колонке с ответом «только 14 сентября»: свой
// пункт в меню был бы вторым способом сделать то же самое.
//
// Меню висит на самой шапке, а не на отдельном значке: у колонки один заголовок, и
// второй орган управления рядом с ним читался бы как что-то ещё.
export type DayState = 'weekly' | 'exception' | 'closed'

export function DayHeader({
  name,
  number,
  today,
  state,
  onCloseDay,
  onResetDay,
}: {
  name: string
  number: string
  today: boolean
  state: DayState
  onCloseDay: () => void
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
        {state !== 'closed' && (
          <DropdownMenuItem onSelect={onCloseDay}>Не принимаю в этот день</DropdownMenuItem>
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
