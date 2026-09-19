import { lossPhrase, stepMeta, type FunnelRow } from './metrics'
import { cn } from '@/lib/utils'

// Воронка формы: «Открыли форму» → шаги → «Отправили форму» (спека
// design/analytics-v3.md §4.1).
//
// РАЗМЕТКА, А НЕ ГРАФИК. До фазы 30 это был горизонтальный BarChart recharts, и три
// его свойства оказались несовместимы с задачей экрана:
//
//   - подпись оси — текст внутри SVG, он не переносится и не сжимается. Поэтому
//     вопрос обрезался на 28-м знаке, и воронка формы из семи вопросов читалась как
//     «7. Как вы узнали о…», «9. Как часто вы поль…»;
//   - потеря нигде не рисовалась: полоски просто становились короче, а число
//     ушедших жило в тултипе — то есть ради главного вопроса экрана нужно было
//     навести мышь на каждую полоску по очереди;
//   - худший шаг называла только фраза в пояснении раздела, на самом графике он
//     ничем не выделялся.
//
// В разметке всё это решается само: подпись — обычный текст и переносится, ушедшие
// — второй сегмент внутри полоски, худший шаг — подложка строки. Заодно «Обзор»
// перестал тянуть recharts вовсе: на первой вкладке аналитики графика больше нет,
// а библиотека тяжёлая (границу держит features/insights/lazyCharts.tsx).
//
// Своя разметка полоски здесь законна ровно потому, что величина у строки НЕ ОДНА:
// у шага их две — дошедшие и ушедшие. Общий BarRows (features/insights/Breakdown)
// остаётся единственной формой для «подпись, число, доля» с одной величиной, и
// заводить рядом с ним третий вид списка по-прежнему нельзя.

// base — сотня процентов: визиты формы. У вопросов одной страницы база та же, чтобы
// полоски двух воронок экрана были соизмеримы.
//
// worstKey — ключ шага, на котором уходит самая большая доля дошедших (metrics.ts,
// worstStep). Нет такого — подсвечивать нечего, и это нормальное состояние: отвалов
// может не быть вовсе или все они ниже порога малых выборок.
export function Funnel({
  rows,
  base,
  worstKey,
}: {
  rows: FunnelRow[]
  base: number
  worstKey?: string
}) {
  return (
    <ol className="flex flex-col gap-1">
      {rows.map((row) => (
        <Step key={row.key} row={row} base={base} worst={row.key === worstKey} />
      ))}
    </ol>
  )
}

function Step({ row, base, worst }: { row: FunnelRow; base: number; worst: boolean }) {
  const share = base > 0 ? row.reached / base : 0
  const percent = Math.round(share * 100)
  // Доля ушедших ВНУТРИ полоски, а не от базы: сегмент рисуется в хвосте дошедших,
  // и его ширина считается от них же. От базы он вылез бы за конец полоски.
  const lostInside = row.reached > 0 ? (row.dropped / row.reached) * 100 : 0
  const loss = lossPhrase(row)
  const meta = stepMeta(row)

  return (
    <li
      className={cn(
        '-mx-2 grid gap-x-4 gap-y-1 rounded-lg px-2 py-1.5',
        'sm:grid-cols-[minmax(10rem,16rem)_minmax(0,1fr)_max-content] sm:items-center',
        // Подложка вместо рамки и вместо цвета состояния: худший шаг — это не отказ
        // системы и не предупреждение, а место на графике (docs/DESIGN-SYSTEM.md,
        // роли цвета). Красная полоса рядом с синей сделала бы из воронки светофор.
        worst && 'bg-muted',
      )}
    >
      {/* Подпись переносится и НЕ обрезается — ради этого воронка и ушла из SVG. */}
      <span className="text-sm">{row.label}</span>

      <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="flex h-full rounded-full" style={{ width: `${share * 100}%` }}>
          <div className="h-full flex-1 rounded-l-full bg-chart-1" />
          {/* Ушедшие — тот же тон в светлоте поменьше: это ЧАСТЬ дошедших, а не
              соседняя категория (docs/DESIGN-SYSTEM.md, «целое и его часть»). */}
          {row.dropped > 0 && (
            <div
              className="h-full rounded-r-full bg-chart-1-soft"
              style={{ width: `${lostInside}%` }}
            />
          )}
        </div>
      </div>

      <span className="text-sm tabular-nums text-muted-foreground">
        {row.reached} · {percent} %
      </span>

      {(loss || meta) && (
        <p
          className={cn(
            'text-sm sm:col-span-2 sm:col-start-2',
            worst ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {[loss, meta].filter(Boolean).join(' · ')}
        </p>
      )}
    </li>
  )
}
