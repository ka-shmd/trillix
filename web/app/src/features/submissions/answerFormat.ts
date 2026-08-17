import { CONSENT_YES, type Block, isSingleChoiceType } from '@entities/formSchema'
import { type AnswerFile, type AnswerValue } from '../../entities/submission'

// Форматирование ответа для таблицы/панели кабинета. choice-значения (id опций)
// резолвятся в подписи по блоку текущей схемы; неизвестный id (ответ прежней
// версии, где опция звалась иначе) выгружается как есть — факт ответа не теряется.
// Для точных кросс-версийных подписей есть CSV-экспорт (там резолв по версии ответа).
export function formatAnswer(
  block: Block | undefined,
  value: AnswerValue | undefined,
  files: Record<string, AnswerFile> = {},
): string {
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
  // Согласие: «yes»/пусто — внутренняя кодировка, владельцу нужен человеческий
  // текст (зеркалит ветку BlockConsent в csv.go).
  if (block?.type === 'consent') {
    return value === CONSENT_YES ? 'Да' : 'Нет'
  }
  // Файлы: в текстовом виде — имена, как в CSV. Ссылками их рисует панель ответа
  // (formatAnswer возвращает строку и знать про разметку не должен).
  if (block?.type === 'file') {
    return Array.isArray(value) ? value.map((id) => files[id]?.name ?? 'файл').join(', ') : ''
  }
  return Array.isArray(value) ? value.join(', ') : value
}

// Файлы ответа: id загрузок из значения плюс имена из карты страницы. Неизвестный
// id (файл удалён вместе с другим ответом, страница устарела) не выбрасывается —
// автор увидит «файл», а не пустую ячейку: факт вложения важнее его имени.
export function answerFiles(
  value: AnswerValue | undefined,
  files: Record<string, AnswerFile>,
): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) return []
  return value.map((id) => ({ id, name: files[id]?.name ?? 'файл' }))
}

function optionLabel(block: Block, id: string): string {
  const opt = block.settings?.options?.find((o) => o.id === id)
  return opt?.label ? opt.label : id
}

function asString(value: AnswerValue): string {
  return Array.isArray(value) ? (value[0] ?? '') : value
}
