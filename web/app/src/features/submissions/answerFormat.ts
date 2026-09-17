import { type Block, isMultiChoiceType, isSingleChoiceType } from '@entities/formSchema'
import { type AnswerFile, type AnswerValue } from '../../entities/submission'
import { LOCALE } from '../../shared/format'

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
  if (block && isMultiChoiceType(block.type)) {
    const ids = Array.isArray(value) ? value : [value]
    return ids.map((id) => optionLabel(block, id)).join(', ')
  }
  // Файлы: в текстовом виде — имена, как в CSV. Ссылками их рисует панель ответа
  // (formatAnswer возвращает строку и знать про разметку не должен).
  if (block?.type === 'file') {
    return Array.isArray(value) ? value.map((id) => files[id]?.name ?? 'файл').join(', ') : ''
  }
  // Запись на время: в ответе лежит момент RFC3339, записанный сервером
  // (design/booking.md §5.6). Сырая строка «2026-09-11T08:00:00Z» автору не значит
  // ничего — показываем то же, что он видит в расписании.
  if (block?.type === 'slot') {
    return formatBookingTime(asString(value))
  }
  return Array.isArray(value) ? value.join(', ') : value
}

// formatBookingTime — время записи по-человечески. Пояс — БРАУЗЕРА автора; пояс
// расписания сюда не приезжает (таблица ответов о расписании не знает), и это
// известное огрубление решения «время у автора — в поясе расписания»: у автора,
// который смотрит свою таблицу из своего же города, разницы нет.
//
// Неразобранное значение отдаётся как есть: ячейка ответов не место, где теряют
// данные.
function formatBookingTime(raw: string): string {
  if (raw === '') return ''
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return raw
  return at.toLocaleString(LOCALE, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
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
