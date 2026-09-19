import { type BlockType, type LogicOperator } from '@entities/formSchema'

// Подписи операторов условия. Общие у редактора логики формы и у фильтра аналитики
// (спека design/analytics-v2.md §6.2): одно условие не должно называться по-разному
// на двух экранах.

// Как оператор зовётся у автора. «Содержит» стоит дважды и это не ошибка: у текста это
// подстрока (contains), у множественного выбора — вариант в ответе (includes), и
// одному типу источника предлагается ровно один из них.
const OPERATOR_LABELS: Record<LogicOperator, string> = {
  is: 'равен',
  is_not: 'не равен',
  contains: 'содержит',
  not_contains: 'не содержит',
  starts_with: 'начинается с',
  not_starts_with: 'не начинается с',
  ends_with: 'заканчивается на',
  not_ends_with: 'не заканчивается на',
  includes: 'содержит',
  excludes: 'не содержит',
  gt: 'больше',
  lt: 'меньше',
  gte: 'больше или равно',
  lte: 'меньше или равно',
  answered: 'отвечен',
  empty: 'не отвечен',
}

// У ДАТЫ порядок называется временем, а не величиной: «дата больше 1 мая» читается как
// ошибка перевода. Оператор при этом тот же самый — разными словами зовётся одно и то
// же сравнение.
const DATE_ORDER_LABELS: Record<'gt' | 'lt' | 'gte' | 'lte', string> = {
  gt: 'позже',
  lt: 'раньше',
  gte: 'не раньше',
  lte: 'не позже',
}

export function operatorLabel(op: LogicOperator, sourceType?: BlockType): string {
  if (sourceType === 'date' && op in DATE_ORDER_LABELS) {
    return DATE_ORDER_LABELS[op as keyof typeof DATE_ORDER_LABELS]
  }
  return OPERATOR_LABELS[op]
}
