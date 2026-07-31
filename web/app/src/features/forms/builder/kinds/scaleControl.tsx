import {
  SCALE_LOWER_BOUND,
  SCALE_UPPER_BOUND,
  type Block,
  scaleRange,
} from '@entities/formSchema'
import { BlockControl } from '@fields/BlockField'

import { useBuilderStore } from '../storeContext'

// ScaleControl — редактор шкалы на полотне: живое превью делений (тот же rf-scale, что
// увидит респондент) плюс выбор диапазона.
//
// Концы выбираются из <select>, а не вводятся числом, намеренно: ValidateSchema строго
// требует min < max в пределах [0,10], а свободный ввод даёт невалидные промежуточные
// состояния (пустое поле, min>max посреди набора) — автосейв ловил бы 422 на каждое
// нажатие. Список вариантов делает такое состояние невозможным.
//
// Выбор диапазона уедет с полотна в попап настроек (этап 16.3): на полотне должно
// оставаться только то, что видит респондент. Пока он здесь — но уже в файле своего типа.

export function ScaleControl({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const { min, max } = scaleRange(block)

  const set = (next: { min?: number; max?: number }) => {
    const m = next.min ?? min
    const x = next.max ?? max
    updateBlock(block.id, {
      // Максимум не может опуститься до минимума: держим его хотя бы на шаг выше.
      settings: { ...block.settings, scaleMin: m, scaleMax: Math.max(x, m + 1) },
    })
  }

  const selectCls =
    'h-7 rounded border border-muted-foreground/30 bg-transparent px-1.5 text-sm text-foreground'

  return (
    <div className="flex flex-col gap-2">
      {/* Только контрол, без FieldShell: подпись рисует строка заголовка выше —
          оболочка дублировала бы её (вопрос стоял бы и над блоком, и над шкалой).
          Просвет подпись→шкала (14px) даёт групповой контейнер, не свой mt (ритм 13.3). */}
      <BlockControl block={block} />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <label className="flex items-center gap-1.5">
          от
          <select
            className={selectCls}
            value={min}
            onChange={(e) => set({ min: Number(e.target.value) })}
          >
            {[SCALE_LOWER_BOUND, SCALE_LOWER_BOUND + 1].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          до
          <select
            className={selectCls}
            value={max}
            onChange={(e) => set({ max: Number(e.target.value) })}
          >
            {Array.from({ length: SCALE_UPPER_BOUND - min }, (_, i) => min + 1 + i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}
