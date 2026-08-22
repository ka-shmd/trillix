import { Heading } from 'lucide-react'

import { type EditorKind } from './contract'

export const heading: EditorKind = {
  menu: { question: false, field: false, layout: true },
  // Имя типа осталось 'heading', а не 'heading_1': тип лежит в опубликованных формах на
  // проде, а переписывать документы схеме нечем. В интерфейсе он «Заголовок 1».
  label: 'Заголовок 1',
  description: 'Крупный заголовок секции формы. Не запрашивает ответ.',
  // Глиф — общий «Heading», а не Heading1: тот занят заголовком ФОРМЫ, а два типа с
  // одним глифом неразличимы там, где подписи нет (сторож — registry.test.ts).
  icon: <Heading className="size-4" />,
  row: {
    surface: 'text',
    name: 'Заголовок 1',
    className: 'rf-heading',
    lineH: 'h-7',
    bold: true,
  },
}
