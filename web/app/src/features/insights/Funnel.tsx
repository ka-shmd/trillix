import { BarRows, type BarRow } from './Breakdown'
import { dropPercent, droppedPhraseShort, stepTime, type FunnelRow } from './metrics'

// Воронка формы: «Открыли форму» → шаги → «Отправили форму» (спека
// design/analytics-v3.md §4.1).
//
// ТАБЛИЦА, А НЕ ГРАФИК, и та же строка-полоска, что у остальной аналитики
// (features/insights/Breakdown.tsx). До фазы 30 это был горизонтальный BarChart
// recharts, и три его свойства оказались несовместимы с задачей экрана:
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
// В таблице всё это решается само: подпись — обычный текст и переносится, ушедшие —
// своя колонка и светлый хвост заливки, худший шаг — подложка строки. Заодно
// «Обзор» перестал тянуть recharts вовсе: на первой вкладке аналитики графика
// больше нет, а библиотека тяжёлая (features/insights/lazyCharts.tsx).
export function Funnel({
  rows,
  base,
  worstKey,
}: {
  rows: FunnelRow[]
  base: number
  worstKey?: string
}) {
  // Колонка времени появляется, только если оно есть хоть у одного шага: время на
  // странице собирается у многостраничных форм, и у остальных пустая колонка
  // «На странице» обещала бы данные, которых не бывает.
  const timed = rows.some((r) => r.timeSec !== undefined || r.leftTimeSec !== undefined)
  return (
    <BarRows
      columns={{
        label: 'Шаг',
        value: 'Дошли',
        extras: timed ? ['Ушли здесь', 'На странице'] : ['Ушли здесь'],
      }}
      rows={rows.map((r) => barRow(r, base, r.key === worstKey, timed))}
    />
  )
}

// base — сотня процентов: визиты формы. У вопросов одной страницы база та же, чтобы
// полоски двух воронок экрана были соизмеримы.
function barRow(row: FunnelRow, base: number, highlight: boolean, timed: boolean): BarRow {
  const share = base > 0 ? row.reached / base : 0
  const pct = dropPercent(row)
  const extras: React.ReactNode[] = [
    row.dropped > 0 ? droppedPhraseShort(row.dropped, pct) : undefined,
  ]
  if (timed) extras.push(stepTime(row))
  return {
    key: row.key,
    label: row.label,
    value: `${row.reached} · ${Math.round(share * 100)} %`,
    share,
    // Ушедшие — часть дошедших, поэтому их доля считается от той же базы.
    lost: base > 0 ? row.dropped / base : 0,
    highlight,
    extras,
  }
}
