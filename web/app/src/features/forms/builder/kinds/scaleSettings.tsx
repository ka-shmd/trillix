import { SCALE_LOWER_BOUND, SCALE_UPPER_BOUND, type Block, scaleRange } from '@entities/formSchema'

import { useBuilderStore } from '../storeContext'
import { SelectSetting, SettingRow } from './settings'

// Диапазон шкалы — типовой раздел попапа настроек (этап 16.3). С полотна он ушёл:
// респондент выбора «от/до» не видит, а полотно показывает только то, что увидит он
// (§1 спеки). Заодно закрыт пункт TD-25 «нативные select'ы в билдере» — здесь
// вендоренный shadcn Select.
//
// Пара, а не два независимых контрола: максимум не может опуститься до минимума, и
// список его значений зависит от выбранного минимума. Ровно эта связь и есть довод
// против генератора форм по спеке (§3.5) — в интерпретаторе она стала бы веткой.

// nextScaleRange — вся арифметика пары, отдельно от JSX: связь «максимум хотя бы на шаг
// выше минимума» и есть то, что здесь можно сломать. Документ с min >= max отвергнет
// ValidateSchema, и автосейв поймал бы 422 на каждый выбор значения.
export function nextScaleRange(
  current: { min: number; max: number },
  next: { min?: number; max?: number },
): { min: number; max: number } {
  const min = next.min ?? current.min
  const max = next.max ?? current.max
  return { min, max: Math.max(max, min + 1) }
}

export function ScaleSettings({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const { min, max } = scaleRange(block)

  const set = (next: { min?: number; max?: number }) => {
    const range = nextScaleRange({ min, max }, next)
    updateBlock(block.id, {
      settings: { ...block.settings, scaleMin: range.min, scaleMax: range.max },
    })
  }

  return (
    <SettingRow label="Шкала">
      <span className="text-muted-foreground">от</span>
      <SelectSetting
        label="Начало шкалы"
        value={min}
        options={[SCALE_LOWER_BOUND, SCALE_LOWER_BOUND + 1]}
        onChange={(v) => set({ min: v })}
      />
      <span className="text-muted-foreground">до</span>
      <SelectSetting
        label="Конец шкалы"
        value={max}
        options={Array.from({ length: SCALE_UPPER_BOUND - min }, (_, i) => min + 1 + i)}
        onChange={(v) => set({ max: v })}
      />
    </SettingRow>
  )
}
