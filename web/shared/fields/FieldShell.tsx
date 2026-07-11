import { type ReactNode } from 'react'

import { type Block } from '@entities/formSchema'

// Обёртка одного поля формы: подпись, звёздочка для обязательных и описание.
// Общая для превью билдера и публичного рендерера (фаза 4) — вид у респондента
// один и тот же. Пустая подпись показывается плейсхолдером, чтобы недособранный
// черновик всё равно выглядел как поле, а не пустота.
export function FieldShell({ block, children }: { block: Block; children: ReactNode }) {
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
    </div>
  )
}
