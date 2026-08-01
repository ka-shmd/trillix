import { type Block } from '@entities/formSchema'

import { FIELD_CLS, FieldWrap } from './fieldWrap'

// DateControl — превью поля даты на полотне. Статичное и намеренно: плейсхолдер в поле
// даты браузер не показывает, править внутри строки нечего, поэтому строка даты — ОБЪЕКТ
// (каретка встаёт на неё саму, кольцом), а не инпут.
//
// pointer-events-none: клик по строке обязан фокусировать остановку, а не открывать
// системный календарь автору формы.
export function DateControl({ block }: { block: Block }) {
  return (
    <FieldWrap block={block}>
      <input type="date" disabled className={`${FIELD_CLS} pointer-events-none`} />
    </FieldWrap>
  )
}
