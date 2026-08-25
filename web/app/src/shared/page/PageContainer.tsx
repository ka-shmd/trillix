import { cn } from '@/lib/utils'

// Колонка страницы кабинета. Ширин ТРИ на весь кабинет, и выбираются они по жанру
// содержимого, а не на глаз:
//
//   narrow  — экраны решений: настройки, тариф. Длинная строка тут вредна.
//   default — одна сущность и её разделы: форма, пространство.
//   wide    — данные: списки, таблицы ответов, аналитика.
//
// Литеральный `max-w-*` в разметке страницы — отступление: до этого компонента в
// кабинете было четыре стихийных ширины, и соседние экраны разъезжались по краю.
const widths = {
  narrow: 'max-w-2xl',
  default: 'max-w-4xl',
  wide: 'max-w-6xl',
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
    <div className={cn('mx-auto w-full px-4 py-5 sm:px-6', widths[width], className)}>
      {children}
    </div>
  )
}
