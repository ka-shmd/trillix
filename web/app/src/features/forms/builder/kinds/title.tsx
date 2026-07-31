import { Type } from 'lucide-react'

import { type EditorKind } from './contract'

export const title: EditorKind = {
  menu: { question: false, field: false, layout: true },
  label: 'Заголовок вопроса',
  description: 'Крупная подпись вопроса. Аналитика берёт из неё имя вопроса.',
  icon: <Type className="size-4" />,
  // Крупная подпись — единственный (вместе с заголовком раздела) тип с 28px строкой,
  // отсюда h-7 у кластера значков.
  row: {
    surface: 'text',
    name: 'Заголовок вопроса',
    className: 'rf-label placeholder:font-semibold',
    lineH: 'h-7',
  },
}
