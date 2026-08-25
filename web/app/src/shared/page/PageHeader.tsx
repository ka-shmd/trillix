import { cn } from '@/lib/utils'

// Шапка содержимого страницы: заголовок, пояснение, ряд состояния и действия
// справа. Крошки и путь назад сюда НЕ входят — они живут в верхнем баре кабинета
// (routes/_app.tsx), один на всё приложение.
//
// Три уровня иерархии задаются здесь и в Section, а не подбираются на каждом
// экране: заголовок страницы text-2xl/bold → заголовок раздела text-lg/semibold →
// название элемента списка text-base/semibold. Каждый следующий на ступень мельче,
// а самый верхний ещё и тяжелее.
export function PageHeader({
  title,
  titleAction,
  description,
  meta,
  actions,
  className,
}: {
  title: React.ReactNode
  // titleAction — кнопка ПРИ заголовке (меню действий над сущностью), а не при
  // странице. Отдельно от `actions`: те живут в верхнем баре и относятся к экрану,
  // эта стоит вплотную к имени и относится к тому, что названо.
  titleAction?: React.ReactNode
  description?: React.ReactNode
  // meta — ряд под заголовком: бейдж статуса, версия, счётчик. Отдельно от
  // description, потому что это состояние сущности, а не текст про неё.
  meta?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
          {titleAction}
        </div>
        {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
        {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
