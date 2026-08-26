import { cn } from '@/lib/utils'

// Колонка страницы кабинета. Ширин ЧЕТЫРЕ на весь кабинет, и выбираются они по
// жанру содержимого, а не на глаз:
//
//   narrow  — экраны решений: настройки, тариф. Длинная строка тут вредна.
//   default — одна сущность и её разделы: форма, пространство.
//   wide    — данные: списки, аналитика.
//   full    — таблица: строк много, колонок много, и потолок ширины означал бы
//             прокрутку вбок при пустых полях по краям.
//
// `full` — единственная ширина без потолка, и берётся она только под таблицу
// (решение владельца: страница ответов). Текст в ней набирать нельзя: строка во
// всю ширину монитора нечитаема, ради чего потолок у остальных трёх и стоит.
//
// Литеральный `max-w-*` в разметке страницы — отступление: до этого компонента в
// кабинете было четыре стихийных ширины, и соседние экраны разъезжались по краю.
const widths = {
  narrow: 'max-w-2xl',
  default: 'max-w-4xl',
  wide: 'max-w-6xl',
  full: 'max-w-none',
} as const

export type PageWidth = keyof typeof widths

export function PageContainer({
  width = 'default',
  className,
  children,
}: {
  width?: PageWidth
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('mx-auto w-full px-5 pt-12 pb-8 sm:px-8', widths[width], className)}>
      {children}
    </div>
  )
}
