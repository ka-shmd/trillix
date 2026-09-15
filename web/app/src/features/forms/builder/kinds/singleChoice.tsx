import { type EditorKind } from './contract'

export const singleChoice: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Один из списка',
  description: 'Выбор одного варианта из списка (радиокнопки).',
  // Choice-тип стартует с ПУСТЫМ списком: в схеме живут только настоящие варианты, а
  // место для набора даёт «призрак» — пустая строка в конце списка, которой в документе
  // нет. Пустой вариант не сохраняется и не публикуется, зато каретке всегда есть куда
  // встать.
  defaults: { settings: { options: [] } },
  row: { surface: 'choice', optionRows: true, optionLook: 'key', lineH: 'h-[var(--rf-control-h)]' },
}
