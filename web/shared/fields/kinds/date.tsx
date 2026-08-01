import { type Control } from './contract'
import { TextInput } from './textInput'

// Дата — нативный date-picker. Один из двух узаконенных нативных контролов (web/CLAUDE.md):
// системный выбор даты на мобиле объективно лучше своего. Плейсхолдер не показывается
// (см. noPlaceholder в TextInput).
export const dateControl: Control = (p) => <TextInput p={p} type="date" noPlaceholder />
