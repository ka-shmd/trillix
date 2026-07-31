import { Ruler } from 'lucide-react'

import { DEFAULT_SCALE_MAX, DEFAULT_SCALE_MIN } from '@entities/formSchema'

import { type EditorKind } from './contract'
import { ScaleControl } from './scaleControl'

export const scale: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Шкала',
  description: 'Оценка по шкале — от 1 до 5, NPS 0–10 и подобное.',
  icon: <Ruler className="size-4" />,
  // Шкала создаётся с диапазоном: схема без него валидна (недособранный черновик), но
  // респонденту нужен готовый ряд делений, а не пустота.
  defaults: { settings: { scaleMin: DEFAULT_SCALE_MIN, scaleMax: DEFAULT_SCALE_MAX } },
  row: { surface: 'object', lineH: 'h-6', Control: ScaleControl, hint: 'object' },
}
