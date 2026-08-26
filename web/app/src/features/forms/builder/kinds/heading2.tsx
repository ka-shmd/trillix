import { type EditorKind } from './contract'

export const heading2: EditorKind = {
  menu: { question: false, field: false, layout: true },
  label: 'Заголовок 2',
  description: 'Подзаголовок внутри раздела. Не запрашивает ответ.',
  // Кегль 20px при line-height 28px — та же высота строки, что у заголовка 1 и вопроса,
  // отсюда h-7 у кластера значков.
  row: {
    surface: 'text',
    name: 'Заголовок 2',
    className: 'rf-heading rf-heading--2',
    lineH: 'h-7',
    bold: true,
  },
}
