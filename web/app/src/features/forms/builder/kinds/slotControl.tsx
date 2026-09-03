import { type Block } from '@entities/formSchema'

import { FieldWrap } from './fieldWrap'

// SlotControl — превью вопроса о записи на полотне. Статичное и намеренно: реальное
// свободное время в кабинете не нужно и требовало бы публичной ручки, а править внутри
// строки нечего — строка записи ОБЪЕКТ (каретка встаёт на неё саму, кольцом), как дата
// и шкала.
//
// Плашка та же, что увидит респондент (`rf-slot` из fields.css): полотно остаётся
// WYSIWYG. Расписание здесь не называется — оно свойство ФОРМЫ, а не вопроса, и живёт
// в попапе строки.
export function SlotControl({ block }: { block: Block }) {
  return (
    <FieldWrap block={block}>
      <div className="rf-slot pointer-events-none">
        <span className="rf-slot-empty">Выбор времени записи</span>
      </div>
    </FieldWrap>
  )
}
