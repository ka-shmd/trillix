import { Cell, Pie, PieChart } from 'recharts'

import { type LabelCount } from '../../entities/visitsBreakdown'
import { pluralViews } from '../../shared/format'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'

// Устройства — кольцо, а не список: категорий две-три, и вопрос к ним не «какая
// больше», а «как поделилось». Соотношение целого читается кольцом с одного
// взгляда, а списком — сложением в уме.
//
// Тона берутся из категориальной части набора (1, 3, 4, 5) и второй ПРОПУСКАЕТСЯ:
// он светлая версия первого и рядом с ним читается как оттенок того же, а не как
// другая категория (комментарий у токенов в index.css).
const SLICES = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

export function DeviceChart({ rows }: { rows: LabelCount[] }) {
  const total = rows.reduce((sum, r) => sum + r.visits, 0)
  // Конфиг собирается из данных: виды устройств приходят с сервера
  // (domain.DeviceLabel), и перечислять их здесь второй раз значило бы завести
  // список, который молчит при появлении нового вида.
  const config: ChartConfig = Object.fromEntries(
    rows.map((r, i) => [r.label, { label: r.label, color: SLICES[i % SLICES.length] }]),
  )

  return (
    <div className="flex items-center gap-4">
      <ChartContainer config={config} className="aspect-square size-36 shrink-0">
        <PieChart>
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent nameKey="label" hideLabel />}
          />
          <Pie data={rows} dataKey="visits" nameKey="label" innerRadius="58%" strokeWidth={2}>
            {rows.map((r, i) => (
              <Cell key={r.label} fill={SLICES[i % SLICES.length]} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      {/* Легенда своя, а не ChartLegendContent: рядом с кольцом ей нужны числа, а
          штатная легенда рисует только подписи. */}
      <ul className="flex min-w-0 flex-col gap-2 text-sm">
        {rows.map((r, i) => (
          <li key={r.label} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: SLICES[i % SLICES.length] }}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {r.visits} · {total > 0 ? Math.round((r.visits / total) * 100) : 0} %
            </span>
          </li>
        ))}
      </ul>
      <span className="sr-only">
        Всего {total} {pluralViews(total)}
      </span>
    </div>
  )
}
