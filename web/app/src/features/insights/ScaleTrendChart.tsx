import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { type ScalePoint } from '../../entities/summary'
import { type BucketStep } from '../../entities/visitsBreakdown'
import { LOCALE } from '../../shared/format'
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'

// Средняя шкалы по времени (спека design/analytics-v2.md §6.1). Линия, а не столбики:
// величина — уровень, а не количество, и столбик читался бы как «больше ответов».
//
// Корзина без ответов — РАЗРЫВ линии, а не ноль: «средняя 0» и «никто не ответил» —
// разные показания, и линия, ныряющая в ноль в пустой день, врала бы о форме.
const chartConfig = {
  avg: { label: 'Средняя', color: 'var(--chart-1)' },
} satisfies ChartConfig

const hourFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' })
const avgFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 })

export function ScaleTrendChart({
  points,
  step,
  min,
  max,
}: {
  points: ScalePoint[]
  step: BucketStep
  min: number
  max: number
}) {
  const tickFmt = step === 'hour' ? hourFmt : dayFmt
  const data = points.map((p) => ({ at: p.at, n: p.n, avg: p.n > 0 ? p.avg : null }))

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-40 w-full">
      <LineChart accessibilityLayer data={data} margin={{ left: 0, right: 8, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="at"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value: string) => tickFmt.format(new Date(value))}
        />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={28} domain={[min, max]} tickCount={3} />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              hideIndicator
              labelFormatter={(_, payload) => {
                const at: unknown = payload[0]?.payload?.at
                return typeof at === 'string' ? tickFmt.format(new Date(at)) : ''
              }}
              formatter={(value, _name, item) => {
                const n: unknown = item.payload?.n
                return (
                  <span className="tabular-nums">
                    Средняя {avgFmt.format(Number(value))}
                    {typeof n === 'number' && ` · ответов ${n}`}
                  </span>
                )
              }}
            />
          }
        />
        <Line
          dataKey="avg"
          stroke="var(--color-avg)"
          strokeWidth={2}
          dot={{ r: 2 }}
          connectNulls={false}
          animationDuration={450}
        />
      </LineChart>
    </ChartContainer>
  )
}
