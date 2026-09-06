import type { Schedule, ScheduleBlock } from '../../entities/schedule'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { LOCALE } from '../../shared/format'

// Что полотно показывает у точки, где щёлкнули: один вопрос — снять ли блокировку.
// Окно приёма спрашивает `WindowPopover`, запись открывается окном `BookingDetails`.
export type Anchor = { x: number; y: number; kind: 'block'; block: ScheduleBlock }

export function CanvasPopover({
  anchor,
  schedule,
  onClose,
  onRemoveBlock,
}: {
  anchor: Anchor | null
  schedule: Schedule
  onClose: () => void
  onRemoveBlock: (id: string) => void
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
          <BlockCard block={anchor.block} timezone={schedule.timezone} onRemove={onRemoveBlock} />
        )}
      </PopoverContent>
    </Popover>
  )
}

function BlockCard({
  block,
  timezone,
  onRemove,
}: {
  block: ScheduleBlock
  timezone: string
  onRemove: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-sm font-semibold">Занятое время</p>
        <p className="text-sm text-muted-foreground">
          {range(block.startsAt, block.endsAt, timezone)}
        </p>
        {block.note && <p className="text-sm">{block.note}</p>}
      </div>
      <Button size="sm" variant="outline" onClick={() => onRemove(block.id)}>
        Снять
      </Button>
    </div>
  )
}

// range — «14 сентября, 10:00 — 11:00» в поясе РАСПИСАНИЯ: прочитай его поясом
// браузера, и автор в поездке увидел бы чужие числа на своём же распорядке.
function range(startsAt: string, endsAt: string, timeZone: string): string {
  const from = new Date(startsAt)
  const to = new Date(endsAt)
  const day = from.toLocaleDateString(LOCALE, { timeZone, day: 'numeric', month: 'long' })
  const time = (d: Date) =>
    d.toLocaleTimeString(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit' })
  return `${day}, ${time(from)} — ${time(to)}`
}
