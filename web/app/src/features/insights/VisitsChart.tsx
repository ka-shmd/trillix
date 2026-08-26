import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'

import { type BucketStep, type TimeBucket } from '../../entities/visitsBreakdown'
import { LOCALE } from '../../shared/format'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'

// Ряд визитов по времени. Столбик СОСТАВНОЙ, а не два столбика рядом: отправившие
// — часть пришедших, а не соседняя величина, и высота столбика обязана читаться как
// «столько людей открыло форму за эту корзину». Парой столбиков целое пришлось бы
// складывать глазом.
//
// Цвета — пара `--chart-1`/`--chart-1-soft`: один тон в двух светлотах, то есть
// «целое и его часть». Категориальный набор колец (`--chart-2..8`) здесь был бы
// неправдой: это не две разные категории визитов, а одна с выделенной долей.
const chartConfig = {
  submitted: { label: 'С ответом', color: 'var(--chart-1)' },
  rest: { label: 'Без ответа', color: 'var(--chart-1-soft)' },
} satisfies ChartConfig

// Въезд столбиков. У recharts по умолчанию 1500 мс — это не появление графика, а
// самостоятельный номер, который приходится пересиживать. График по времени стоит
// вне вкладок и рисуется раз на заход, поэтому анимация у него остаётся, но
// короткая.
const ENTRY_MS = 450

const hourFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' })
const hourFullFmt = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})
const dayFullFmt = new Intl.DateTimeFormat(LOCALE, {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
})

export function VisitsChart({ buckets, step }: { buckets: TimeBucket[]; step: BucketStep }) {
  const tickFmt = step === 'hour' ? hourFmt : dayFmt
  const fullFmt = step === 'hour' ? hourFullFmt : dayFullFmt
  // Второй ряд считается здесь, а не на сервере: это та же величина под другим
  // углом (визиты минус отправившие), и заводить ради неё поле в контракте значит
  // разрешить двум числам разъехаться.
  const data = buckets.map((b) => ({ ...b, rest: b.visits - b.submitted }))

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-60 w-full">
      <BarChart accessibilityLayer data={data} margin={{ left: 0, right: 0, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="at"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value: string) => tickFmt.format(new Date(value))}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={32}
          tickCount={4}
          allowDecimals={false}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => {
                const at: unknown = payload[0]?.payload?.at
                return typeof at === 'string' ? fullFmt.format(new Date(at)) : ''
              }}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {/* Отправившие — В ОСНОВАНИИ столбика: доля, ради которой график и смотрят,
            стоит на оси и сравнивается между корзинами по одной линии. Закругление
            только у верхнего сегмента — иначе шов посреди столбика. */}
        <Bar
          dataKey="submitted"
          stackId="visits"
          fill="var(--color-submitted)"
          animationDuration={ENTRY_MS}
        />
        <Bar
          dataKey="rest"
          stackId="visits"
          fill="var(--color-rest)"
          radius={[3, 3, 0, 0]}
          animationDuration={ENTRY_MS}
        />
      </BarChart>
    </ChartContainer>
  )
}
