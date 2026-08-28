import { Loader2, TriangleAlert, type LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type SaveStatus } from './useAutosave'

// Индикатор автосейва в шапке билдера — компактная иконка с тултипом (текст
// статуса раскрывается по наведению/фокусу). Ошибка кликабельна: сама иконка —
// кнопка «повторить». Конфликт несёт нейтральный статус, подробности и действие —
// у ConflictBanner. TooltipProvider даёт SidebarProvider выше по дереву.
//
// saved — БЕЗ иконки (решение владельца): «всё сохранено» — состояние по
// умолчанию, а не событие, и иконка на него в шапке была лишним, вечно горящим
// сигналом. Индикатор появляется, только когда есть что показать — идёт сохранение
// или что-то пошло не так.
const META: Record<
  Exclude<SaveStatus, 'saved'>,
  { icon: LucideIcon; className: string; label: string }
> = {
  saving: {
    icon: Loader2,
    className: 'text-primary animate-spin',
    label: 'Сохранение…',
  },
  error: {
    icon: TriangleAlert,
    className: 'text-destructive',
    label: 'Не удалось сохранить. Нажмите, чтобы повторить',
  },
  conflict: {
    icon: TriangleAlert,
    className: 'text-destructive',
    label: 'Сохранение приостановлено',
  },
}

export function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  if (status === 'saved') return null

  const { icon: Icon, className, label } = META[status]

  // Ошибка — кнопка (повтор автосейва); остальные состояния информационны (span).
  const trigger =
    status === 'error' ? (
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onRetry}
        aria-label={label}
      >
        <Icon className={`size-4 ${className}`} />
      </Button>
    ) : (
      <span
        role="status"
        aria-label={label}
        tabIndex={0}
        className="flex size-8 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon className={`size-4 ${className}`} />
      </span>
    )

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// ConflictBanner — форму изменили в другой вкладке (409). Оптимистичная блокировка
// в MVP разрешается перезагрузкой: перечитать серверную версию и продолжить с неё.
export function ConflictBanner() {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-sm"
      role="alert"
    >
      <span>
        Форма изменена в другой вкладке. Обновите страницу, чтобы продолжить редактирование.
      </span>
      <button
        type="button"
        className="font-medium text-destructive underline underline-offset-2"
        onClick={() => window.location.reload()}
      >
        Обновить
      </button>
    </div>
  )
}
