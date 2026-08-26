import { type EditorKind } from './contract'

export const numberField: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Число',
  description: 'Числовой ответ — количество, возраст, сумма.',
  row: { surface: 'placeholder', lineH: 'h-[var(--rf-control-h)]' },
}
