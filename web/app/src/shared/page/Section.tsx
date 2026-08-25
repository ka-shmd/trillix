import { cn } from '@/lib/utils'

// Раздел внутри страницы: заголовок, пояснение, необязательное действие справа и
// содержимое.
//
// ЗАГОЛОВОК РАЗДЕЛА КРУПНЕЕ НАЗВАНИЯ ЭЛЕМЕНТА ВНУТРИ НЕГО НА СТУПЕНЬ: 20/700
// против 16/600. Пока оба были `font-medium` одного размера, раздел и его
// содержимое читались как один уровень, и структура страницы пропадала.
//
// Вертикальный ритм — пять значений на весь кабинет, у каждого своя работа
// (docs/DESIGN-SYSTEM.md): 4 внутри пары «заголовок и его подпись», 8 между
// однородными строками, 16 между блоком и его содержимым, 32 поля страницы,
// 48 между разделами.
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
    <section className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold tracking-tight">{title}</h2>
          {/* Пояснение не шире половины раздела: строка во всю ширину экрана
              нечитаема, а короткая мера сама отделяет пояснение от содержимого.
              На узком экране половина превратилась бы в колонку в пять слов,
              поэтому ограничение начинается с sm. */}
          {description && (
            <p className="mt-1 max-w-full text-base text-muted-foreground sm:max-w-[50%]">
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
