import { type ReactNode } from 'react'

// Обёртка контрола одного поля: сам контрол и — в рендерере — сообщение об ошибке
// валидации. Общая для превью билдера и публичного рендерера. Подписи (title/label)
// в v2 — отдельные блоки группы, поэтому оболочка их НЕ рисует: только контрол и
// ошибку. error/errorId передаёт только рендерер; в превью их нет — вид не меняется.
export function FieldShell({
  children,
  error,
  errorId,
}: {
  children: ReactNode
  error?: string
  errorId?: string
}) {
  return (
    <div className="rf-field">
      {children}
      {error && (
        <p className="rf-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
