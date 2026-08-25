import { cn } from '@/lib/utils'

// Шапка содержимого страницы: заголовок, пояснение, ряд состояния и действия
// справа. Крошки и путь назад сюда НЕ входят — они живут в верхнем баре кабинета
// (routes/_app.tsx), один на всё приложение.
//
// Верхняя ступень шкалы кеглей кабинета (вся шкала — docs/DESIGN-SYSTEM.md):
// заголовок страницы 30/800 → заголовок раздела 20/700 → название элемента 16/600.
// Вторичный текст всегда на ступень мельче того, к чему относится, — это и есть
// правило, по которому размер не приходится подбирать на каждом экране.
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
          <h1 className="truncate text-3xl font-extrabold tracking-tight">{title}</h1>
          {titleAction}
        </div>
        {description && <p className="mt-1 text-base text-muted-foreground">{description}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
