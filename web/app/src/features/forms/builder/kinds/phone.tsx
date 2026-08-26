import { type EditorKind } from './contract'

export const phone: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Телефон',
  description: 'Номер телефона. Проверяется мягко — любой формат записи.',
  row: { surface: 'placeholder', lineH: 'h-[var(--rf-control-h)]' },
}
