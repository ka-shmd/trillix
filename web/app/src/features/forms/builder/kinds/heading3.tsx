import { Heading3 } from 'lucide-react'

import { type EditorKind } from './contract'

export const heading3: EditorKind = {
  menu: { question: false, field: false, layout: true },
  label: 'Заголовок 3',
  description: 'Мелкий заголовок — кегль тела формы, отличается весом. Не запрашивает ответ.',
  icon: <Heading3 className="size-4" />,
  // Кегль тела (16px) и его же line-height 24px — h-6 у кластера значков, как у абзаца.
  row: {
    surface: 'text',
    name: 'Заголовок 3',
    className: 'rf-heading rf-heading--3',
    lineH: 'h-6',
    bold: true,
  },
}
