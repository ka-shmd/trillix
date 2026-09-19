import { SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'

import { AnswerFilterBar } from './AnswerFilterBar'
import { SegmentPicker } from './SegmentPicker'
import { type BlockSummary } from '../../entities/summary'
import { decodeFilter, type FilterCondition } from '../../shared/answerFilter'
import { type Period } from '../../shared/period'
import { segmentDimLabels, splitSegment } from '../../shared/segment'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// Выборка сводки: сегмент по визиту и условия по ответам — ОДНОЙ кнопкой (решение
// владельца 2026-09-19: «много неудобных контролов»).
//
// Раньше над списком вопросов стояли два ряда органов управления: выпадающий список
// измерения, выпадающий список значения, кнопка сброса и рядом панель условий. Они
// занимали столько же места, сколько первый вопрос, и стояли там всегда — включая
// те девять случаев из десяти, когда никакой выборки не настраивают.
//
// Теперь на экране видно ПРИМЕНЁННОЕ, а не средства его применить: пока выборка
// пуста, это одна кнопка. Настроенная выборка показывается бейджами рядом с ней —
// иначе числа под ней врали бы молча.
export function ScopeBar({
  formId,
  period,
  segment,
  where,
  blocks,
  onSegment,
  onWhere,
}: {
  formId: string
  period: Period
  segment: string | undefined
  where: string | undefined
  // Вопросы для панели условий — из сводки БЕЗ выборки: при пустом результате или
  // закрытом тарифе отфильтрованной сводки нет, а менять условия всё равно нужно.
  blocks: BlockSummary[]
  onSegment: (next: string | undefined) => void
  onWhere: (next: FilterCondition[]) => void
}) {
  const [open, setOpen] = useState(false)
  const conditions = decodeFilter(where)
  const seg = splitSegment(segment)
  const applied = (seg ? 1 : 0) + conditions.length

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <SlidersHorizontal className="size-4" />
            Выборка
            {applied > 0 && (
              <Badge variant="secondary" className="ml-1 tabular-nums">
                {applied}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        {/* Ширина по содержимому панели условий, а не по кнопке: внутри два
            выпадающих списка в ряд. */}
        <PopoverContent align="start" className="flex w-96 flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">Кто отвечал</p>
            <SegmentPicker formId={formId} period={period} segment={segment} onChange={onSegment} />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">Что ответил</p>
            {blocks.length > 0 ? (
              <AnswerFilterBar blocks={blocks} conditions={conditions} onChange={onWhere} />
            ) : (
              <p className="text-sm text-muted-foreground">Вопросов пока нет.</p>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Применённое — рядом с кнопкой, а не только внутри окна: закрыв окно,
          человек обязан видеть, по какой совокупности считаются числа. */}
      {seg && (
        <Badge variant="secondary" className="font-normal">
          {segmentDimLabels[seg.dim]}: {seg.value}
        </Badge>
      )}
      {conditions.length > 0 && (
        <Badge variant="secondary" className="font-normal">
          условий по ответам: {conditions.length}
        </Badge>
      )}
      {applied > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onSegment(undefined)
            onWhere([])
          }}
        >
          Сбросить
        </Button>
      )}
    </div>
  )
}
