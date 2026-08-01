import { ChoiceList } from './choiceList'
import { type Control } from './contract'

// Один из списка — радиокнопки-карточки с буквенными бейджами.
export const singleChoiceControl: Control = (p) => (
  <ChoiceList
    block={p.block}
    multiple={false}
    value={p.value}
    onChange={p.onChange}
    disabled={p.disabled}
    onBlur={p.onBlur}
  />
)
