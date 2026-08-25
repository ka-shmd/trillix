import { cn } from '@/lib/utils'

// Шапка содержимого страницы: заголовок, пояснение, ряд состояния и действия
// справа. Крошки и путь назад сюда НЕ входят — они живут в верхнем баре кабинета
// (routes/_app.tsx), один на всё приложение.
//
// Кегль заголовка (text-xl) на ступень меньше заголовка секции внутри неё и
// заметно крупнее названия элемента списка: три уровня иерархии задаются здесь и
// в Section, а не подбираются на каждом экране.
export function PageHeader({
  title,
  description,
  meta,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  // meta — ряд под заголовком: бейдж статуса, версия, счётчик. Отдельно от
  // description, потому что это состояние сущности, а не текст про неё.
  meta?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
