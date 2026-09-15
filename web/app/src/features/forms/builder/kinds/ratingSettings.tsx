import { RATING_STARS_MAX, RATING_STARS_MIN, type Block, ratingCount } from '@entities/formSchema'

import { useBuilderStore } from '../storeContext'
import { SelectSetting, SettingRow } from './settings'

const STAR_OPTIONS = Array.from(
  { length: RATING_STARS_MAX - RATING_STARS_MIN + 1 },
  (_, i) => RATING_STARS_MIN + i,
)

// Число звёзд — типовой раздел попапа настроек. Закрытый список, а не числовое поле:
// валидатор строг к диапазону, и свободный ввод ловил бы 422 автосейва на каждое нажатие.
export function RatingSettings({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  return (
    <SettingRow label="Звёзд">
      <SelectSetting
        label="Число звёзд"
        value={ratingCount(block)}
        options={STAR_OPTIONS}
        onChange={(v) => updateBlock(block.id, { settings: { ...block.settings, ratingStars: v } })}
      />
    </SettingRow>
  )
}
