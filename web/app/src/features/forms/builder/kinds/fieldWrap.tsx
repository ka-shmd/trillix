import { type ReactNode } from 'react'

import { type Block } from '@entities/formSchema'

import { typeIcon } from '../blockTypeIcons'
import './fieldWrap.css'

// Вид поля на полотне — общий rf-input (единый с превью и рендерером); rf-input-typed
// даёт место под глиф типа справа (см. index.css). canvas-field — свой, полотный:
// снимает голубое кольцо фокуса fields.css и добавляет тень на hover (fieldWrap.css).
export const FIELD_CLS = 'rf-input rf-input-typed canvas-field'

// FieldWrap — обёртка поля: якорь глифа типа. Ширину берёт из .rf-field-wrap (index.css),
// где стоит тот же потолок --rf-input-max, что у поля. Просвет подпись→поле (14px) даёт
// групповой контейнер (gap-3.5 у GroupRow) — свой mt тут не нужен (был бы двойным
// отступом и ломал ритм 13.3).
//
// Глиф типа в правом углу — подсказка автору, ЧТО это за поле, когда подпись ещё не
// написана. Только в редакторе: у респондента тип виден по самому контролу, и в публичной
// форме Tally такого глифа нет (проверено замером). Иконка берётся из реестра типов — того же
// словаря, что в slash-меню и диалоге добавления, чтобы тип выглядел одинаково везде, где
// о нём говорят. pointer-events-none обязателен: иначе глиф съедает клик по правому краю
// поля.
export function FieldWrap({
  block,
  children,
  wide = false,
  // Многострочное поле: глиф встаёт к верхней строке, а не по центру высоты.
  glyphTop = false,
}: {
  block: Block
  children: ReactNode
  wide?: boolean
  glyphTop?: boolean
}) {
  return (
    <div className={`rf-field-wrap ${wide ? 'rf-field-wrap--wide' : ''}`}>
      {children}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute right-2 text-muted-foreground/70 ${
          glyphTop ? 'top-2' : 'top-1/2 -translate-y-1/2'
        }`}
      >
        {typeIcon(block.type)}
      </span>
    </div>
  )
}
