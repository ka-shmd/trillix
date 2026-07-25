import { useActiveRow } from './activeRow'
import { chipText, formatLabel, shortcutsFor } from './shortcuts'

// Сколько чипов показываем у строки. Три — потолок из §7 спеки: подсказка должна
// читаться боковым зрением, а не изучаться. Что попадёт в тройку, решает ПОРЯДОК
// списка в SHORTCUTS (первым — самое релевантное действию строки).
const MAX_CHIPS = 3

// RowHints — чипы у сфокусированной строки (§7, слой 2). Показывают ТОЛЬКО клавиши,
// специфичные этой поверхности: общие (меню действий, удаление, ↑↓, undo) вынесены в
// шпаргалку Mod+/ — иначе у каждой строки висит один и тот же хвост и чипы перестают
// читаться (решение владельца 2026-07-25).
//
// Компонент подписан на активную строку САМ и рисуется у каждой строки всегда: так
// смена каретки перерисовывает только чипы, а не строки целиком (мемоизация строк
// запрещена до профайлера — TD-32).
//
// Всё вне потока и без событий: absolute + pointer-events-none. Контрол, который
// появляется по фокусу и занимает место в потоке, схлопывается на mousedown и съедает
// клик — TD-22, закон полотна.
export function RowHints({ rowId, lineH }: { rowId: string; lineH: string }) {
  const active = useActiveRow()
  if (!active || active.id !== rowId) return null
  const list = shortcutsFor(active.ctx, { hasAnswer: active.hasAnswer }).slice(0, MAX_CHIPS)
  if (list.length === 0) return null

  return (
    <div
      aria-hidden="true"
      // Чипы — визуальная подсказка зрячему автору; скринридеру они мусор (клавиши
      // всё равно не нажать «по чипу»), полная карта доступна ему в шпаргалке.
      //
      // right-0 + top-1.5: правый край колонки строки, на уровне первой строки текста
      // (top-1.5 = вертикальный padding строки, как у кластера значков слева). Правое
      // ПОЛЕ строки занято тоглом обязательности (left-full) — не пересекаемся.
      // Фон непрозрачный: длинная подпись занимает всю колонку и проходит под чипами.
      // animate-in fade-in: проявление через opacity (§7) — чипы должны «проступать»,
      // а не мигать при каждом переезде каретки. Утилита из tw-animate-css, та же, что
      // у оверлеев shadcn; своей анимации (motion) тут не нужно.
      className={`pointer-events-none absolute right-0 top-1.5 flex ${lineH} animate-in items-center gap-3 rounded-md bg-background pl-3 text-xs text-muted-foreground fade-in duration-150`}
    >
      {list.map((s) => (
        <span key={s.label} className="flex items-center gap-1.5 whitespace-nowrap">
          <kbd className="rounded border border-border bg-muted px-1 py-px font-sans text-[11px] leading-4 text-foreground/70">
            {formatLabel(s.label)}
          </kbd>
          {chipText(s)}
        </span>
      ))}
    </div>
  )
}
