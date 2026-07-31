import { type Control } from './contract'
import { TextInput } from './textInput'

// Длинный ответ — textarea на три строки. Растёт не сама, а прокруткой: высота поля в
// форме — часть раскладки, и «резиновое» поле дёргало бы всё ниже себя.
export const longTextControl: Control = (p) => <TextInput p={p} rows={3} />
