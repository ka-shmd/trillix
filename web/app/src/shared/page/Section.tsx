import { cn } from '@/lib/utils'

// Раздел внутри страницы: заголовок, пояснение, необязательное действие справа и
// содержимое.
//
// ЗАГОЛОВОК РАЗДЕЛА КРУПНЕЕ НАЗВАНИЯ ЭЛЕМЕНТА ВНУТРИ НЕГО НА СТУПЕНЬ: 20/700
// против 16/600. Пока оба были `font-medium` одного размера, раздел и его
// содержимое читались как один уровень, и структура страницы пропадала.
//
// Вертикальный ритм — шесть значений на весь кабинет, у каждого своя работа
// (docs/DESIGN-SYSTEM.md): 4 внутри пары «заголовок и его подпись», 8 между
// однородными строками, 16 между элементами блока, 24 между заголовком раздела и
// его содержимым, 32 поля страницы, 48 между разделами.
//
// Пояснение раздела ограничено половиной его ширины — см. комментарий в разметке.
export function Section({
  id,
  title,
  description,
  action,
  className,
  children,
}: {
  // id — якорь раздела: на него ссылаются хешем извне (образец — вкладка
  // «Частичные», отправляющая за тумблером сбора в настройки формы).
  id?: string
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className={cn('@container flex flex-col gap-6', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold tracking-tight">{title}</h2>
          {/* Пояснение не шире половины раздела — но только у ШИРОКОГО раздела:
              строка во всю страницу нечитаема, а в колонке на пол-экрана половина
              превратилась бы в текст в пять слов.

              Порог считается по ширине САМОГО раздела (@container), а не экрана:
              разделы стоят и во всю ширину, и парами в две колонки, и правило про
              меру строки зависит от того, сколько места у раздела, а не сколько его
              у окна. */}
          {description && (
            <p className="mt-1 max-w-full text-sm text-muted-foreground @2xl:max-w-[50%]">
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
