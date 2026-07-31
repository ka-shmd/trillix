import { type Control } from './contract'
import { TextInput } from './textInput'

// Число. Ответ всё равно хранится строкой (конвенция проекта): type="number" здесь — про
// клавиатуру и шаговые кнопки, а не про формат значения.
export const numberControl: Control = (p) => <TextInput p={p} type="number" />
