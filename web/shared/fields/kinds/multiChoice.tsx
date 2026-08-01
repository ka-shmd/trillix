import { ChoiceList } from './choiceList'
import { type Control } from './contract'

// Несколько из списка — чекбоксы: глиф видим, карточек и букв нет. Единственный тип, чей
// ответ — массив id.
export const multiChoiceControl: Control = (p) => (
  <ChoiceList
    block={p.block}
    multiple={true}
    value={p.value}
    onChange={p.onChange}
    disabled={p.disabled}
    onBlur={p.onBlur}
  />
)
