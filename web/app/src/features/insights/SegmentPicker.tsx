import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { versionStatsQueryOptions, visitsBreakdownQueryOptions } from './queries'
import { segmentOptions } from './segment'
import { type Period } from '../../shared/period'
import { isSegmentDim, segmentDimLabels, splitSegment, type SegmentDim } from '../../shared/segment'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const ALL = 'all'

// Выбор сегмента: измерение, затем его значение. Сегмент живёт в адресе, а
// выбранное, но ещё без значения измерение — в локальном состоянии: пока значения
// нет, сегмента тоже нет, и экран показывает все визиты.
//
// Значения берутся из разбивки «Визитов» за то же окно (и из разреза версий) — те же
// подписи, по которым сервер находит визиты сегмента.
export function SegmentPicker({
  formId,
  period,
  segment,
  onChange,
}: {
  formId: string
  period: Period
  segment: string | undefined
  onChange: (segment: string | undefined) => void
}) {
  const current = splitSegment(segment)
  const [pendingDim, setPendingDim] = useState<SegmentDim | null>(null)
  const dim = pendingDim ?? current?.dim ?? null

  const breakdown = useQuery({
    ...visitsBreakdownQueryOptions(formId, period),
    enabled: dim !== null && dim !== 'version',
  })
  const versions = useQuery({
    ...versionStatsQueryOptions(formId, period),
    enabled: dim === 'version',
  })
  const options = dim ? segmentOptions(dim, breakdown.data, versions.data) : []
  const loading = dim === 'version' ? versions.isPending : breakdown.isPending

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={dim ?? ALL}
        onValueChange={(value) => {
          if (!isSegmentDim(value)) {
            setPendingDim(null)
            onChange(undefined)
            return
          }
          setPendingDim(value)
          // Новое измерение — старое значение к нему не относится.
          if (current && current.dim !== value) onChange(undefined)
        }}
      >
        <SelectTrigger className="w-[180px]" aria-label="Сегмент">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Все визиты</SelectItem>
          {Object.entries(segmentDimLabels).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {dim && (
        <Select
          value={current?.dim === dim ? current.value : ''}
          onValueChange={(value) => {
            setPendingDim(null)
            onChange(`${dim}:${value}`)
          }}
          disabled={options.length === 0}
        >
          <SelectTrigger className="w-[220px]" aria-label={segmentDimLabels[dim]}>
            <SelectValue placeholder={loading ? 'Загрузка…' : options.length === 0 ? 'Нет значений' : 'Выберите…'} />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {(segment || dim) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setPendingDim(null)
            onChange(undefined)
          }}
        >
          Сбросить
        </Button>
      )}
    </div>
  )
}
