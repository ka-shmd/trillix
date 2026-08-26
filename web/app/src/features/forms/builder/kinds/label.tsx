import { type EditorKind } from './contract'

export const label: EditorKind = {
  menu: { question: false, field: false, layout: true },
  label: 'Подпись',
  description: 'Мелкая подпись поля — для компактных вопросов и полей регистрации.',
  row: {
    surface: 'text',
    name: 'Подпись поля',
    className: 'rf-label rf-label--sm',
    lineH: 'h-6',
    bold: true,
  },
}
