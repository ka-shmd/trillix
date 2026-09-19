import { Cell, Pie, PieChart } from 'recharts'

import { type LabelCount } from '../../entities/visitsBreakdown'
import { conversionText, percentOf } from './metrics'
import { type ChartConfig, ChartContainer, ChartTooltip } from '@/components/ui/chart'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// Кольцо разбивки: одна форма на все шесть списков вкладки «Визиты» — источники,
// страны, города, устройства, браузеры, системы. Вопрос ко всем один и тот же:
// «как поделилось», и отвечает на него доля целого, а не сравнение строк.
//
// Строка — та же LabelCount, что у остальных разбивок: подпись, число визитов и
// сколько из них отправили форму.
// Своего типа у кольца нет намеренно — заведи его, и границу ленивой загрузки
// пришлось бы пересекать импортом типа отсюда.
//
// Строки приходят УЖЕ отсортированными по убыванию (сервер сортирует их в SQL,
// вторым ключом — по подписи, чтобы соседние обновления не переставляли строки
// местами). Здесь порядок не пересчитывается: своя сортировка была бы второй
// копией правила, а расходится она молча.

// Сектора красятся РАЗНЫМИ ТОНАМИ, по одному на строку. Восемь ступеней одного
// синего человек между собой не различает — кольцо из них не отвечает ни на один
// вопрос, ради которого на него смотрят. Тона расставлены в index.css так, чтобы
// соседи по порядку были далеко друг от друга по цветовому кругу: сектора идут
// подряд, и слипаются именно соседи.
//
// Порядок токенов совпадает с порядком строк, а строки отсортированы по убыванию.
// Значит, у самой большой доли всегда синий, и цвет между обновлениями экрана не
// прыгает, пока не меняется сам порядок.
const SLICE_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
]

function sliceFill(label: string, index: number): string {
  // «Прочее» — не строка разбивки, а её отсутствие, поэтому нейтральный серый, а не
  // девятый тон: цветным оно читалось бы как ещё один браузер. И место у него в
  // кольце не «самое маленькое» — сумма хвоста бывает больше третьей строки.
  if (label === OTHER) return 'var(--muted-foreground)'
  return SLICE_COLORS[index] ?? 'var(--muted-foreground)'
}

// TOP — сколько строк получают свой сектор; ровно столько, сколько есть тонов.
// Девятая строка и дальше уезжают в «Прочее»: кольцо из пятнадцати секторов это не
// разбивка, а полосатый круг, а хвост из одного визита в нём неотличим от волоса.
// Числа хвоста не теряются — они под наведением на «Прочее».
//
// Считается от длины палитры, а не задаётся числом: разъехавшись, эти две величины
// дали бы два сектора одного цвета — молча и только на девятой строке.
const TOP = SLICE_COLORS.length

// TAIL_SHOWN — сколько строк хвоста печатать в подсказке. Дальше идёт «и ещё N»:
// подсказка во весь экран не читается, а хвост бывает длиной в сотню городов.
const TAIL_SHOWN = 12

export function ShareChart({ rows }: { rows: LabelCount[] }) {
  const total = rows.reduce((sum, r) => sum + r.visits, 0)
  const head = rows.slice(0, TOP)
  const tail = rows.slice(TOP)
  const tailTotal = tail.reduce((sum, r) => sum + r.visits, 0)
  const tailSubmitted = tail.reduce((sum, r) => sum + r.submitted, 0)
  const slices: LabelCount[] =
    tail.length > 0
      ? [...head, { label: OTHER, visits: tailTotal, submitted: tailSubmitted }]
      : head

  // Конфиг собирается из данных: подписи приходят с сервера, и перечислять их
  // здесь второй раз значило бы завести список, который молчит при появлении
  // нового браузера или города.
  const config: ChartConfig = Object.fromEntries(slices.map((r) => [r.label, { label: r.label }]))

  return (
    <div className="flex flex-col gap-4 @xs:flex-row @xs:items-center">
      <ChartContainer config={config} className="aspect-square size-32 shrink-0">
        <PieChart>
          <ChartTooltip cursor={false} content={<ShareTooltip total={total} tail={tail} />} />
          {/* Кольцо НЕ анимируется. Оно живёт во вкладке, вкладка при переключении
              размонтируется, и въезд проигрывался бы заново на каждый щелчок —
              раздражение вместо украшения. Одноразовая анимация тут невозможна:
              компонент не знает, показывают его впервые или в пятый раз. */}
          <Pie
            data={slices}
            dataKey="visits"
            nameKey="label"
            innerRadius="58%"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {slices.map((r, i) => (
              <Cell
                key={r.label}
                fill={sliceFill(r.label, i)}
                fillOpacity={r.label === OTHER ? 0.45 : 1}
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
          {/* Шапка колонок: у числа строки две величины — сколько пришло и какая их
              часть отправила форму, — и без подписи вторую не отличить от доли. */}
          <li className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden="true">
            <span className="ml-auto shrink-0">Визиты</span>
            <span className="w-16 shrink-0 text-right">Отправили</span>
          </li>
          {slices.map((r, i) => (
            <li key={r.label} className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-[2px]"
                style={{
                  backgroundColor: sliceFill(r.label, i),
                  opacity: r.label === OTHER ? 0.45 : 1,
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
              <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                {conversionText(r.submitted, r.visits)}
              </span>
            </li>
          ))}
        </ul>
      </TooltipProvider>
    </div>
  )
}

const OTHER = 'Прочее'

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
        <>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">{row.label}</span>
            <span className="font-medium tabular-nums">
              {row.visits} · {percentOf(row.visits, total)} %
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Отправили</span>
            <span className="tabular-nums">{conversionText(row.submitted, row.visits)}</span>
          </div>
        </>
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
