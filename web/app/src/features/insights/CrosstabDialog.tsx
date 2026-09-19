import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { type BlockSummary, type Crosstab } from '../../entities/summary'
import { MIN_BASE, percentOf } from './metrics'
import { crosstabQueryOptions } from './queries'
import { ApiError } from '../../shared/api/errors'
import { type Period } from '../../shared/period'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// «Сравнить»: таблица сопряжённости вопроса сводки с другим закрытым вопросом (спека
// design/analytics-v2.md §6.3). Строки — варианты этого вопроса, столбцы — второго,
// доля — от строки: «из выбравших Pro 40 % поставили 5». Ниже порога малых выборок
// у строки только числа.
export function CrosstabDialog({
  open,
  onOpenChange,
  formId,
  period,
  where,
  segment,
  block,
  others,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  formId: string
  period: Period
  where?: string
  segment?: string
  block: BlockSummary
  others: BlockSummary[]
}) {
  const [colId, setColId] = useState('')
  const table = useQuery({
    ...crosstabQueryOptions(formId, period, block.blockId, colId, where, segment),
    enabled: open && colId !== '',
  })
  const planRequired =
    table.isError && table.error instanceof ApiError && table.error.code === 'plan_required'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="break-words">{block.label}</DialogTitle>
          <DialogDescription>Как ответы на этот вопрос делятся по ответам на другой.</DialogDescription>
        </DialogHeader>
        <Select value={colId} onValueChange={setColId}>
          <SelectTrigger aria-label="Сравнить с вопросом" className="w-full sm:w-80">
            <SelectValue placeholder="Сравнить с вопросом…" />
          </SelectTrigger>
          <SelectContent>
            {others.map((b) => (
              <SelectItem key={b.blockId} value={b.blockId}>
                {b.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {colId === '' ? null : table.isPending ? (
          <p className="text-sm text-muted-foreground">Считаем…</p>
        ) : planRequired ? (
          <p className="text-sm text-muted-foreground">Сравнение вопросов доступно на тарифе с аналитикой.</p>
        ) : table.isError ? (
          <p className="text-sm text-muted-foreground">Не удалось посчитать таблицу.</p>
        ) : table.data.withheld ? (
          <p className="text-sm text-muted-foreground">В выборке меньше 5 ответов — таблица не показывается.</p>
        ) : table.data.total === 0 ? (
          <p className="text-sm text-muted-foreground">Никто не ответил на оба вопроса.</p>
        ) : (
          <CrossTable data={table.data} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function CrossTable({ data }: { data: Crosstab }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead />
            {data.cols.map((c) => (
              <TableHead key={c.key} className="text-right">
                {c.label}
              </TableHead>
            ))}
            <TableHead className="text-right">Всего</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((r, i) => {
            const shown = r.total >= MIN_BASE
            return (
              <TableRow key={r.key}>
                <TableCell className="font-medium">{r.label}</TableCell>
                {data.cols.map((c, j) => {
                  const n = data.cells[i]?.[j] ?? 0
                  const pct = percentOf(n, r.total)
                  return (
                    <TableCell
                      key={c.key}
                      className="text-right tabular-nums"
                      // Интенсивность — доля от строки: самая частая пара видна без чтения чисел.
                      style={
                        shown && n > 0
                          ? { backgroundColor: `color-mix(in oklab, var(--chart-1) ${Math.round(pct * 0.6)}%, transparent)` }
                          : undefined
                      }
                    >
                      {shown ? `${n} · ${pct} %` : n}
                    </TableCell>
                  )
                })}
                <TableCell className="text-right tabular-nums text-muted-foreground">{r.total}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
