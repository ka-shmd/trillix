import { type EditorKind } from './contract'

export const heading: EditorKind = {
  menu: { question: false, field: false, layout: true },
  // Имя типа осталось 'heading', а не 'heading_1': тип лежит в опубликованных формах на
  // проде, а переписывать документы схеме нечем. В интерфейсе он «Заголовок 1».
  label: 'Заголовок 1',
  description: 'Крупный заголовок секции формы. Не запрашивает ответ.',
  row: {
    surface: 'text',
    name: 'Заголовок 1',
    className: 'rf-heading',
    lineH: 'h-7',
    bold: true,
  },
}
