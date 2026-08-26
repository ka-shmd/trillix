import { Cell, Pie, PieChart } from 'recharts'

import { type LabelCount } from '../../entities/visitsBreakdown'
import { percentOf } from './metrics'
import { type ChartConfig, ChartContainer, ChartTooltip } from '@/components/ui/chart'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// Кольцо разбивки: одна форма на все шесть списков вкладки «Визиты» — источники,
// страны, города, устройства, браузеры, системы. Вопрос ко всем один и тот же:
// «как поделилось», и отвечает на него доля целого, а не сравнение строк.
//
// Строка — та же LabelCount, что у остальных разбивок: подпись и число визитов.
// Своего типа у кольца нет намеренно — заведи его, и границу ленивой загрузки
// пришлось бы пересекать импортом типа отсюда.
//
// Строки приходят УЖЕ отсортированными по убыванию (сервер сортирует их в SQL,
// вторым ключом — по подписи, чтобы соседние обновления не переставляли строки
// местами). Здесь порядок не пересчитывается: своя сортировка была бы второй
// копией правила, а расходится она молча.

// TOP — сколько строк получают свой сектор. Девятая и дальше уезжают в «Прочее»:
// кольцо из пятнадцати секторов это не разбивка, а полосатый круг, а хвост из
// одного визита в нём неотличим от волоса. Числа хвоста не теряются — они под
// наведением на «Прочее».
const TOP = 8

// TAIL_SHOWN — сколько строк хвоста печатать в подсказке. Дальше идёт «и ещё N»:
// подсказка во весь экран не читается, а хвост бывает длиной в сотню городов.
const TAIL_SHOWN = 12

export function ShareChart({ rows }: { rows: LabelCount[] }) {
  const total = rows.reduce((sum, r) => sum + r.visits, 0)
  const head = rows.slice(0, TOP)
  const tail = rows.slice(TOP)
  const tailTotal = tail.reduce((sum, r) => sum + r.visits, 0)
  const slices: LabelCount[] =
    tail.length > 0 ? [...head, { label: OTHER, visits: tailTotal }] : head

  // Конфиг собирается из данных: подписи приходят с сервера, и перечислять их
  // здесь второй раз значило бы завести список, который молчит при появлении
  // нового браузера или города.
  const config: ChartConfig = Object.fromEntries(slices.map((r) => [r.label, { label: r.label }]))

  return (
    <div className="flex flex-col gap-4 @xs:flex-row @xs:items-center">
      <ChartContainer config={config} className="aspect-square size-32 shrink-0">
        <PieChart>
          <ChartTooltip cursor={false} content={<ShareTooltip total={total} tail={tail} />} />
          <Pie data={slices} dataKey="visits" nameKey="label" innerRadius="58%" strokeWidth={2}>
            {slices.map((r, i) => (
              <Cell
                key={r.label}
                fill={sliceFill(r.label)}
                fillOpacity={sliceOpacity(r.label, i, slices.length)}
              />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>

      {/* Легенда своя, а не ChartLegendContent: рядом с кольцом ей нужны числа и
          доли, а штатная легенда рисует только подписи.

          Свой TooltipProvider, хотя выше по дереву есть общий (его даёт
          SidebarProvider оболочки кабинета): без него компонент падал бы всюду, где
          этой оболочки нет, — начиная с собственного теста. Вложенный провайдер
          Radix разрешает. */}
      <TooltipProvider>
        <ul className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
          {slices.map((r, i) => (
            <li key={r.label} className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-[2px]"
                style={{
                  backgroundColor: sliceFill(r.label),
                  opacity: sliceOpacity(r.label, i, slices.length),
                }}
                aria-hidden="true"
              />
              {r.label === OTHER ? (
                // «Прочее» объясняется наведением и в легенде тоже: до строки списка
                // мышь доходит чаще, чем до узкого сектора кольца.
                <Tooltip>
                  <TooltipTrigger className="min-w-0 truncate underline decoration-dotted underline-offset-4">
                    {r.label}
                  </TooltipTrigger>
                  {/* Светлая подсказка вместо штатной тёмной: рядом стоит подсказка
                    кольца, и один и тот же список в двух разных оболочках читался
                    бы как две разные вещи. */}
                  <TooltipContent className="border border-border/50 bg-background text-foreground shadow-xl">
                    <TailList rows={tail} total={total} />
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className="min-w-0 truncate">{r.label}</span>
              )}
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                {r.visits} · {percentOf(r.visits, total)} %
              </span>
            </li>
          ))}
        </ul>
      </TooltipProvider>
    </div>
  )
}

const OTHER = 'Прочее'

// Цвет кодирует ВЕЛИЧИНУ, а не категорию. У браузеров, городов и источников
// категории не несут смысла — у них есть только размер, — поэтому берётся ОДИН
// тон в убывающей плотности, а не восемь разных. Восемь тонов пришлось бы
// согласовывать между собой, с тёплой нейтралью и с тёмной темой, и они всё равно
// сообщали бы различие, которого в данных нет.
//
// Плотность даётся прозрачностью, а не восемью значениями цвета: тон остаётся
// одним и тем же токеном, и на тёмной теме рампа разворачивается сама.
function sliceFill(label: string): string {
  // «Прочее» — не строка разбивки, а её отсутствие, поэтому нейтральный серый:
  // следующей ступенью рампы он читался бы как ещё один браузер. И размер у него
  // не «самый маленький» — сумма хвоста бывает больше третьей строки.
  return label === OTHER ? 'var(--muted-foreground)' : 'var(--chart-1)'
}

function sliceOpacity(label: string, index: number, count: number): number {
  if (label === OTHER) return 0.3
  return 1 - (index / Math.max(count - 1, 1)) * 0.6
}

// Подсказка кольца. Своя, а не ChartTooltipContent: у сектора «Прочее» она
// разворачивается в список того, что внутри, — ради этого хвост и сворачивался.
//
// Пропсы необязательны, потому что recharts подставляет active и payload сам,
// клонируя переданный элемент.
function ShareTooltip({
  active,
  payload,
  total,
  tail,
}: {
  active?: boolean
  payload?: { payload?: LabelCount }[]
  total: number
  tail: LabelCount[]
}) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null

  return (
    <div className="grid min-w-[8rem] gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      {row.label === OTHER ? (
        <TailList rows={tail} total={total} />
      ) : (
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{row.label}</span>
          <span className="font-medium tabular-nums">
            {row.visits} · {percentOf(row.visits, total)} %
          </span>
        </div>
      )}
    </div>
  )
}

// Список свёрнутого хвоста: то же, что показывал бы длинный список, но по запросу.
function TailList({ rows, total }: { rows: LabelCount[]; total: number }) {
  const shown = rows.slice(0, TAIL_SHOWN)
  const hidden = rows.length - shown.length
  const sum = rows.reduce((acc, r) => acc + r.visits, 0)

  return (
    <div className="grid gap-1 text-xs">
      <p className="font-medium">
        Прочее: {sum} · {percentOf(sum, total)} %
      </p>
      {shown.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4">
          <span className="max-w-40 truncate text-muted-foreground">{r.label}</span>
          <span className="tabular-nums">
            {r.visits} · {percentOf(r.visits, total)} %
          </span>
        </div>
      ))}
      {hidden > 0 && <p className="text-muted-foreground">и ещё {hidden}</p>}
    </div>
  )
}
