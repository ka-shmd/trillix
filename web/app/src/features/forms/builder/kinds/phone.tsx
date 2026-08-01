import { Phone } from 'lucide-react'

import { type EditorKind } from './contract'

export const phone: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Телефон',
  description: 'Номер телефона. Проверяется мягко — любой формат записи.',
  icon: <Phone className="size-4" />,
  row: { surface: 'placeholder', lineH: 'h-6' },
}
