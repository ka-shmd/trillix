import { AlignLeft } from 'lucide-react'

import { type EditorKind } from './contract'

export const longText: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Длинный ответ',
  description: 'Многострочный развёрнутый ответ.',
  icon: <AlignLeft className="size-4" />,
  row: { surface: 'placeholder', multiline: true, lineH: 'h-[var(--rf-control-h)]' },
}
