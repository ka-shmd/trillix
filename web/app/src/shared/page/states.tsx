import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

// Три состояния, без которых экран с данными не готов (web/CLAUDE.md): загрузка,
// отказ, пусто. До этих компонентов каждый экран рисовал свои — отсюда и «Загрузка…»
// голым абзацем рядом с вендоренным Skeleton, и пять почти одинаковых коробок ошибки
// с разным паддингом.

// Отказ запроса. role="alert" обязателен: экран сменился молча, и без него
// скринридер не скажет об этом ничего.
export function ErrorState({
  title = 'Не удалось загрузить данные.',
  description,
  onRetry,
  retryLabel = 'Повторить',
  className,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  onRetry?: () => void
  retryLabel?: string
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn('rounded-lg border border-destructive/40 bg-destructive/5 p-4', className)}
    >
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  )
}

// Пусто — это ЖАНР, а не отсутствие блока: раздел, который при нуле элементов
// просто не рисуется, читается как недогрузившаяся страница.
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center',
        className,
      )}
    >
      {Icon && <Icon className="size-6 text-muted-foreground" aria-hidden />}
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

// Загрузка списка одинаковых строк. Свой скелет остаётся законным там, где форма
// содержимого своя (грид карточек, таблица ответов) — этот покрывает частый случай
// «несколько строк подряд».
export function LoadingRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  )
}
