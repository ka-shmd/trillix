import { type EditorKind } from './contract'

export const multiSelect: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Теги',
  description: 'Выбор нескольких вариантов из выпадающего списка с поиском. Удобен, когда вариантов много.',
  defaults: { settings: { options: [] } },
  // Рядов у вариантов нет, как у выпадающего списка: у респондента они живут в списке
  // под полем, а не на полотне формы.
  row: { surface: 'choice', optionRows: false, optionLook: 'tag', lineH: 'h-[var(--rf-control-h)]' },
}
