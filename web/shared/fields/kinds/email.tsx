import { type Control } from './contract'
import { TextInput } from './textInput'

// Email. type="email" даёт мобильной клавиатуре «@» — проверку формата всё равно делают
// рендерер и сервер, браузерной валидации здесь не доверяем.
export const emailControl: Control = (p) => (
  <TextInput p={p} type="email" fallbackPlaceholder="you@example.com" />
)
