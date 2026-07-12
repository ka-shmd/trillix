import { type ReactNode } from 'react'

import { type Block } from '@entities/formSchema'

// Обёртка одного поля формы: подпись, звёздочка для обязательных, описание и —
// в рендерере — сообщение об ошибке валидации. Общая для превью билдера и
// публичного рендерера (вид у респондента один и тот же). Пустая подпись
// показывается плейсхолдером, чтобы недособранный черновик выглядел как поле.
// error/errorId передаёт только рендерер; в превью их нет — вид не меняется.
export function FieldShell({
  block,
  children,
  error,
  errorId,
}: {
  block: Block
  children: ReactNode
  error?: string
  errorId?: string
}) {
  const label = block.label.trim() || 'Без названия'
  return (
    <div className="rf-field">
      <div className="rf-label">
        {label}
        {block.required && (
          <span className="rf-required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </div>
      {block.description && <p className="rf-desc">{block.description}</p>}
      {children}
      {error && (
        <p className="rf-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
