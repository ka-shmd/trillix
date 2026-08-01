import { type ChangeEvent } from 'react'

import { type ControlProps, invalidAttrs, placeholderOf, textValue } from './contract'

// Общий контрол ввода: шесть типов (короткий и длинный ответ, email, телефон, число,
// дата) отличались друг от друга одной-двумя строками JSX, а написаны были шестью почти
// дословными копиями. Копии тем и опасны, что расходятся молча: правка a11y или класса в
// одной из шести не видна в остальных пяти.
//
// Вид один на все три поверхности — класс rf-input из fields.css.
// Пропсы — РАЗДЕЛЁННОЕ объединение, а не общий мешок с необязательными полями: иначе
// `rows` вместе с `type` компилировался бы, а рисовалась бы textarea, молча уронив тип
// поля. Один-единственный тип с textarea (длинный ответ) не повод оставлять эту ловушку
// открытой — ветвление ниже читает `rows`, и цена ошибки не видна на месте вызова.
type TextInputProps = { p: ControlProps } & (
  | {
      // Многострочный ввод: textarea на rows строк. Атрибута type у него нет.
      rows: number
      type?: never
      noPlaceholder?: never
      fallbackPlaceholder?: string
    }
  | {
      rows?: never
      type: 'text' | 'email' | 'tel' | 'number' | 'date'
      // Дата плейсхолдера не показывает вовсе, даже если он лежит в настройках: в поле
      // даты браузер рисует свой формат, и авторский текст туда всё равно не попадает.
      // Флаг, а не «пустой fallback»: отсутствие атрибута — намеренное свойство типа.
      noPlaceholder?: boolean
      // Плейсхолдер-образец, когда автор своего не задал: у email и телефона он
      // показывает ОЖИДАЕМЫЙ ФОРМАТ, а не подсказку по смыслу вопроса.
      fallbackPlaceholder?: string
    }
)

export function TextInput({ p, type, rows, fallbackPlaceholder, noPlaceholder }: TextInputProps) {
  const value = textValue(p.value)
  const onChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    p.onChange?.(e.target.value)
  const placeholder = noPlaceholder ? undefined : (placeholderOf(p.block) ?? fallbackPlaceholder)

  if (rows) {
    return (
      <textarea
        className="rf-input"
        rows={rows}
        value={value}
        onChange={onChange}
        disabled={p.disabled}
        aria-label={p.label}
        placeholder={placeholder}
        {...invalidAttrs(p)}
      />
    )
  }
  return (
    <input
      className="rf-input"
      type={type}
      value={value}
      onChange={onChange}
      disabled={p.disabled}
      aria-label={p.label}
      placeholder={placeholder}
      {...invalidAttrs(p)}
    />
  )
}
