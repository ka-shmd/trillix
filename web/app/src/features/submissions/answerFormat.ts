import { type Block, isSingleChoiceType } from '@entities/formSchema'
import { type AnswerValue } from '../../entities/submission'

// Форматирование ответа для таблицы/панели кабинета. choice-значения (id опций)
// резолвятся в подписи по блоку текущей схемы; неизвестный id (ответ прежней
// версии, где опция звалась иначе) выгружается как есть — факт ответа не теряется.
// Для точных кросс-версийных подписей есть CSV-экспорт (там резолв по версии ответа).
export function formatAnswer(block: Block | undefined, value: AnswerValue | undefined): string {
  if (value === undefined) return ''
  // Одиночный выбор (single_choice, dropdown) — по предикату, а не по типу: новый
  // choice-тип иначе выгружался бы сырым id вместо подписи варианта.
  if (block && isSingleChoiceType(block.type)) {
    return optionLabel(block, asString(value))
  }
  if (block?.type === 'multi_choice') {
    const ids = Array.isArray(value) ? value : [value]
    return ids.map((id) => optionLabel(block, id)).join(', ')
  }
  return Array.isArray(value) ? value.join(', ') : value
}

function optionLabel(block: Block, id: string): string {
  const opt = block.settings?.options?.find((o) => o.id === id)
  return opt?.label ? opt.label : id
}

function asString(value: AnswerValue): string {
  return Array.isArray(value) ? (value[0] ?? '') : value
}
