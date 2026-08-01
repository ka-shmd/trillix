import { type Control, invalidAttrs, textValue } from './contract'

// Выпадающий список: та же модель опций и тот же формат ответа, что у single_choice (id
// варианта строкой) — отличается только контролом. Нативный <select>: на телефоне он
// открывается системным колесом, а длинный список не распирает форму на пол-экрана (ради
// этого тип и заведён).
//
// Пустой первый пункт — это «не выбрано»: без него select показывал бы первый вариант
// выбранным, и необязательный вопрос молча получал бы ответ.
export const dropdownControl: Control = (p) => {
  const options = p.block.settings?.options ?? []
  if (options.length === 0) {
    return <p className="rf-empty">Варианты пока не добавлены</p>
  }
  return (
    <select
      className="rf-input rf-select"
      value={textValue(p.value)}
      onChange={(e) => p.onChange?.(e.target.value)}
      disabled={p.disabled}
      aria-label={p.label}
      {...invalidAttrs(p)}
    >
      <option value="">Выберите вариант</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label.trim() || 'Вариант'}
        </option>
      ))}
    </select>
  )
}
