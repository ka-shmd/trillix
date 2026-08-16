import { CheckSquare } from 'lucide-react'

import { type EditorKind } from './contract'

export const multiChoice: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Несколько из списка',
  description: 'Выбор нескольких вариантов из списка (флажки).',
  icon: <CheckSquare className="size-4" />,
  defaults: { settings: { options: [] } },
  row: { surface: 'choice', optionRows: true, lineH: 'h-[var(--rf-control-h)]' },
}
