import { Bar, BarChart, LabelList, XAxis, YAxis } from 'recharts'

import { type FormFunnel } from '../../entities/funnel'
import { droppedPhrase, percentOf } from './metrics'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'

// Воронка одним графиком: «Открыли форму» → вопросы по порядку → «Отправили форму».
// Один жанр разметки на все ступени, 26 пикселей на строку — форма из пятнадцати
// вопросов помещается на экран целиком. Карточка на вопрос стоила бы вчетверо
// больше высоты и ничего не добавляла: величина у всех строк одна.
//
// Ступени и шаги — ОДИН ряд одного цвета, потому что величина у них одна: сколько
// визитов сюда дошло. Красить их по-разному значило бы намекать на разный смысл.
const chartConfig = {
  reached: { label: 'Дошли', color: 'var(--chart-1)' },
} satisfies ChartConfig

const ROW_HEIGHT = 26

type Row = {
  label: string
  full: string
  reached: number
  dropped: number
  caption: string
}

// Подпись оси не переносится и не сжимается — это текст внутри SVG. Поэтому
// длинный вопрос обрезается здесь, а целиком показывается в тултипе: обрезать в
// обоих местах значило бы спрятать текст вопроса вовсе.
const LABEL_LIMIT = 28

function short(label: string): string {
  return label.length > LABEL_LIMIT ? `${label.slice(0, LABEL_LIMIT - 1)}…` : label
}

export function FunnelChart({ funnel }: { funnel: FormFunnel }) {
  const { visits, submitted, steps } = funnel
  const rows: Row[] = [
    row('Открыли форму', visits, funnel.leftBeforeFirst, visits),
    ...steps.map((s, i) => row(`${i + 1}. ${s.label}`, s.reached, s.droppedHere, visits)),
    row('Отправили форму', submitted, 0, visits),
  ]

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto w-full"
      style={{ height: rows.length * ROW_HEIGHT + 16 }}
    >
      <BarChart
        accessibilityLayer
        layout="vertical"
        data={rows}
        margin={{ left: 0, right: 72, top: 4, bottom: 4 }}
        barSize={14}
      >
        {/* Ось значений спрятана: числа стоят подписью у конца каждой полоски, и
            вторая шкала внизу читалась бы как отдельная информация. */}
        <XAxis type="number" dataKey="reached" domain={[0, Math.max(visits, 1)]} hide />
        <YAxis
          type="category"
          dataKey="label"
          tickLine={false}
          axisLine={false}
          width={170}
          tickMargin={4}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              hideIndicator
              labelFormatter={(_, payload) => {
                const full: unknown = payload[0]?.payload?.full
                return typeof full === 'string' ? full : ''
              }}
              formatter={(value, _name, item) => {
                const dropped: unknown = item.payload?.dropped
                return (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium tabular-nums">Дошли: {String(value)}</span>
                    {typeof dropped === 'number' && dropped > 0 && (
                      <span className="text-muted-foreground">{droppedPhrase(dropped)}</span>
                    )}
                  </div>
                )
              }}
            />
          }
        />
        <Bar dataKey="reached" fill="var(--color-reached)" radius={3}>
          <LabelList
            dataKey="caption"
            position="right"
            offset={8}
            className="fill-muted-foreground tabular-nums"
            fontSize={12}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

function row(label: string, reached: number, dropped: number, base: number): Row {
  const pct = percentOf(reached, base)
  return { label: short(label), full: label, reached, dropped, caption: `${reached} · ${pct} %` }
}
