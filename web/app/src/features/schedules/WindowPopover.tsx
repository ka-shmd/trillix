import type { TimeWindow } from '../../entities/schedule'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

// Одно действие над окном приёма — убрать его.
//
// Вопроса об объёме («каждый вторник» или «только 16-го») здесь НЕТ: на него
// ответила поверхность, с которой пришёл клик. На «Приёме» убирается день недели, в
// правке часов одного дня — только этот день, и подпись приезжает сверху.
export type WindowAnchor = { x: number; y: number; date: string; window: TimeWindow }

export function WindowPopover({
  anchor,
  title,
  onClose,
  onRemove,
}: {
  anchor: WindowAnchor | null
  title: string
  onClose: () => void
  onRemove: (date: string, window: TimeWindow) => void
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
            <p className="px-1 pb-1 text-sm text-muted-foreground">{title}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRemove(anchor.date, anchor.window)}
            >
              Убрать
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
