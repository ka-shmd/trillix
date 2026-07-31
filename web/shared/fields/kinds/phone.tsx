import { type Control } from './contract'
import { TextInput } from './textInput'

// Телефон. Образец в плейсхолдере — российский формат, но проверка мягкая (isValidPhone):
// поле принимает и +380, и добавочные. Маски нет намеренно — она отсекает легальные
// номера.
export const phoneControl: Control = (p) => (
  <TextInput p={p} type="tel" fallbackPlaceholder="+7 900 000-00-00" />
)
