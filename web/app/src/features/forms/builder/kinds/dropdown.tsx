import { type EditorKind } from './contract'

export const dropdown: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Выпадающий список',
  description: 'Выбор одного варианта из списка. Удобен, когда вариантов много.',
  defaults: { settings: { options: [] } },
  row: { surface: 'choice', optionRows: false, lineH: 'h-[var(--rf-control-h)]' },
}
