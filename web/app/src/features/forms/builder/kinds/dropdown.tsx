import { ChevronDown } from 'lucide-react'

import { type EditorKind } from './contract'

export const dropdown: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Выпадающий список',
  description: 'Выбор одного варианта из списка. Удобен, когда вариантов много.',
  icon: <ChevronDown className="size-4" />,
  defaults: { settings: { options: [] } },
  row: { surface: 'choice', lineH: 'h-6', optionRows: false },
}
