import { Bar, BarChart, LabelList, XAxis, YAxis } from 'recharts'

import { dropPercent, droppedPhrase, type FunnelRow, percentOf } from './metrics'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'

// Воронка одним графиком: «Открыли форму» → шаги по порядку → «Отправили форму».
// Строки собирает вызывающий (metrics.ts: funnelRows, pageQuestionRows) — график не
// знает, страницы у него в шагах, вопросы или вопросы одной страницы без ступеней.
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
  // Доля ушедших среди дошедших; null ниже порога малых выборок.
  dropPercent: number | null
  caption: string
}

// Подпись оси не переносится и не сжимается — это текст внутри SVG. Поэтому
// длинный вопрос обрезается здесь, а целиком показывается в тултипе: обрезать в
// обоих местах значило бы спрятать текст вопроса вовсе.
const LABEL_LIMIT = 28

function short(label: string): string {
  return label.length > LABEL_LIMIT ? `${label.slice(0, LABEL_LIMIT - 1)}…` : label
}

// base — сотня процентов у подписей и ширина оси: визиты формы. У вопросов одной
// страницы база та же, чтобы полоски двух графиков экрана были соизмеримы.
export function FunnelChart({ rows: input, base }: { rows: FunnelRow[]; base: number }) {
  const rows = input.map((r) => row(r, base))

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
        <XAxis type="number" dataKey="reached" domain={[0, Math.max(base, 1)]} hide />
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
                const pct: unknown = item.payload?.dropPercent
                return (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium tabular-nums">Дошли: {String(value)}</span>
                    {typeof dropped === 'number' && dropped > 0 && (
                      <span className="text-muted-foreground">
                        {droppedPhrase(dropped)}
                        {typeof pct === 'number' && ` — ${pct} % дошедших`}
                      </span>
                    )}
                  </div>
                )
              }}
            />
          }
        />
        {/* 450 мс вместо полутора секунд по умолчанию: воронка рисуется раз на
            заход, но полтора секунды въезда приходится пересиживать. */}
        <Bar dataKey="reached" fill="var(--color-reached)" radius={3} animationDuration={450}>
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

function row(r: FunnelRow, base: number): Row {
  const pct = percentOf(r.reached, base)
  return {
    label: short(r.label),
    full: r.label,
    reached: r.reached,
    dropped: r.dropped,
    dropPercent: dropPercent(r),
    caption: `${r.reached} · ${pct} %`,
  }
}
