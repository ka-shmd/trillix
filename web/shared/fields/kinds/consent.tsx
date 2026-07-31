import { CONSENT_YES, plainText } from '@entities/formSchema'

import { RichText } from '../richText'
import { type Control, invalidAttrs, textValue } from './contract'

// Согласие: галочка с текстом владельца рядом (текст — свой у блока, оболочка FieldShell
// его не дублирует). Обязательность — обычный флаг required (решение владельца):
// необязательное согласие это маркетинг-opt-in.
//
// Значение — CONSENT_YES или пусто, строкой: тип Answer не расширяется, а «пусто» даёт
// обязательность даром (см. isEmpty в validation.ts рендерера). Булев false туда бы не
// попал, и required у согласия молча перестал бы работать.
export const consentControl: Control = (p) => {
  const checked = textValue(p.value) === CONSENT_YES
  return (
    <label className="rf-option">
      <input
        className="rf-mark rf-mark--check"
        type="checkbox"
        checked={checked}
        onChange={(e) => p.onChange?.(e.target.checked ? CONSENT_YES : '')}
        disabled={p.disabled}
        {...invalidAttrs(p)}
      />
      <span className="rf-consent">
        {plainText(p.block.text).trim() ? (
          <RichText spans={p.block.text} inert={p.disabled} />
        ) : (
          'Текст согласия'
        )}
        {p.block.required && (
          /* Пробел внутри строки, а не {' '} рядом с «*»: тот же текстовый узел, что до переезда. */
          <span className="rf-required" aria-hidden="true">{' *'}</span>
        )}
      </span>
    </label>
  )
}
