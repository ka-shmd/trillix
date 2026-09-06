import type { TimeWindow } from '../../entities/schedule'
import { WEEKDAY_EVERY, weekdayOf } from './canvas'
import { LOCALE } from '../../shared/format'
import type { Scope } from './canvasEdit'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

// Убрать окно приёма — и в каком объёме.
//
// Вопрос тот же, что у окна протяжки, и по той же причине: полоса на 16 сентября —
// это и «каждый вторник», и «только 16-е», а угадать нечем. Двумя кнопками, а не
// табами: действие одно, выбор один, и окно ради него разворачивать незачем.
export type WindowAnchor = { x: number; y: number; date: string; window: TimeWindow }

export function WindowPopover({
  anchor,
  onClose,
  onRemove,
}: {
  anchor: WindowAnchor | null
  onClose: () => void
  onRemove: (date: string, window: TimeWindow, scope: Scope) => void
}) {
  return (
    <Popover open={anchor !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Якорь — точка мыши, а не элемент события: события полотна перерисовываются
          после каждой правки, и ссылка на прежний DOM-узел протухла бы ровно в тот
          момент, когда всплывашка должна открыться. */}
      <PopoverAnchor asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed"
          style={{ left: anchor?.x ?? 0, top: anchor?.y ?? 0 }}
        />
      </PopoverAnchor>
      <PopoverContent align="start" className="w-auto max-w-80 p-2">
        {anchor && (
          <div className="flex flex-col gap-1">
            <p className="px-1 text-sm font-semibold">
              {anchor.window.from} — {anchor.window.to}
            </p>
            <p className="px-1 pb-1 text-sm text-muted-foreground">Убрать приём</p>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onRemove(anchor.date, anchor.window, 'weekly')}
              >
                {WEEKDAY_EVERY[weekdayOf(anchor.date)]}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onRemove(anchor.date, anchor.window, 'date')}
              >
                Только {dayTitle(anchor.date)}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function dayTitle(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(LOCALE, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
  })
}
