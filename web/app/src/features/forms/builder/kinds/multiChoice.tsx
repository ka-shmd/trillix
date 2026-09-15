import { type EditorKind } from './contract'

export const multiChoice: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Несколько из списка',
  description: 'Выбор нескольких вариантов из списка (флажки).',
  defaults: { settings: { options: [] } },
  row: { surface: 'choice', optionRows: true, optionLook: 'check', lineH: 'h-[var(--rf-control-h)]' },
}
