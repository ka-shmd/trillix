import { Hash } from 'lucide-react'

import { type EditorKind } from './contract'

export const numberField: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Число',
  description: 'Числовой ответ — количество, возраст, сумма.',
  icon: <Hash className="size-4" />,
  row: { surface: 'placeholder', lineH: 'h-6' },
}
