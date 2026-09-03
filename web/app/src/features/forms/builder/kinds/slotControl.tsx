import { type Block } from '@entities/formSchema'
import { SlotPlate } from '@fields/kinds/slot'

import { FieldWrap } from './fieldWrap'

// SlotControl — превью вопроса о записи на полотне. Статичное и намеренно: реальное
// свободное время в кабинете не нужно и требовало бы публичной ручки, а править внутри
// строки нечего — строка записи ОБЪЕКТ (каретка встаёт на неё саму, кольцом), как дата
// и шкала.
//
// Плашка — та же самая, что увидит респондент (SlotPlate из @fields): полотно остаётся
// WYSIWYG не по совпадению разметки, а по общему коду. Расписание здесь не называется —
// оно свойство ФОРМЫ, а не вопроса, и живёт в попапе строки.
export function SlotControl({ block }: { block: Block }) {
  return (
    <FieldWrap block={block}>
      <SlotPlate value="" className="pointer-events-none" />
    </FieldWrap>
  )
}
