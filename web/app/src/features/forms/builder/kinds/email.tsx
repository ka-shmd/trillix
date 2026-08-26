import { type EditorKind } from './contract'

export const email: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Email',
  description: 'Адрес электронной почты с проверкой формата.',
  row: { surface: 'placeholder', lineH: 'h-[var(--rf-control-h)]' },
}
