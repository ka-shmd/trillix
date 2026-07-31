import { Heading } from 'lucide-react'

import { type EditorKind } from './contract'

export const heading: EditorKind = {
  menu: { question: false, field: false, layout: true },
  label: 'Заголовок раздела',
  description: 'Крупный заголовок секции формы. Не запрашивает ответ.',
  icon: <Heading className="size-4" />,
  row: {
    surface: 'text',
    name: 'Заголовок раздела',
    className: 'rf-heading placeholder:font-semibold',
    lineH: 'h-7',
  },
}
