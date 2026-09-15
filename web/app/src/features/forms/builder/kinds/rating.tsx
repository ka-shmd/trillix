import { DEFAULT_RATING_STARS } from '@entities/formSchema'

import { type EditorKind } from './contract'
import { RatingControl } from './ratingControl'
import { RatingSettings } from './ratingSettings'

export const rating: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Рейтинг',
  description: 'Оценка звёздами — от трёх до десяти звёзд.',
  defaults: { settings: { ratingStars: DEFAULT_RATING_STARS } },
  row: {
    surface: 'object',
    Control: RatingControl,
    hint: 'object',
    lineH: 'h-[var(--rf-control-h)]',
  },
  // Число звёзд правится в попапе, как диапазон шкалы: у респондента этого выбора нет.
  Settings: RatingSettings,
}
