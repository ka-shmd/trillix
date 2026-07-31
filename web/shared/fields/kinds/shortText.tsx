import { type Control } from './contract'
import { TextInput } from './textInput'

// Короткий ответ — однострочное поле.
export const shortTextControl: Control = (p) => <TextInput p={p} type="text" />
