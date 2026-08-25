import { cn } from '@/lib/utils'

// Раздел внутри страницы: заголовок, пояснение, необязательное действие справа и
// содержимое.
//
// ЗАГОЛОВОК РАЗДЕЛА И НАЗВАНИЕ ЭЛЕМЕНТА ВНУТРИ НЕГО ОБЯЗАНЫ ОТЛИЧАТЬСЯ И КЕГЛЕМ, И
// НАСЫЩЕННОСТЬЮ: text-base/semibold против text-sm/medium у строки списка. Пока
// оба были `font-medium` одного размера, раздел и его содержимое читались как один
// уровень, и структура страницы пропадала.
//
// Вертикальный ритм кабинета — три значения, других нет: gap-8 между разделами,
// gap-3 внутри раздела, gap-2 между элементами списка (docs/DESIGN-SYSTEM.md).
//
// Пояснение раздела ограничено половиной его ширины — см. комментарий в разметке.
export function Section({
  title,
  description,
  action,
  className,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {/* Пояснение не шире половины раздела: строка во всю ширину экрана
              нечитаема, а короткая мера сама отделяет пояснение от содержимого.
              На узком экране половина превратилась бы в колонку в пять слов,
              поэтому ограничение начинается с sm. */}
          {description && (
            <p className="mt-0.5 max-w-full text-sm text-muted-foreground sm:max-w-[50%]">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}
