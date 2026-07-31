import { isAnswerableType, plainText, type Block } from '@entities/formSchema'
import { groupMeta } from '@fields/groups'

import { editorKind } from './kinds/index'

// Как вопрос называется в данных (заголовок колонки CSV, шаг воронки, ключ сводки).
// ЗЕРКАЛО internal/domain/questions.go — правится тем же PR. Цепочка одна, а входов в
// неё два, и разница между ними существенна:
//
//   • authoredQuestionName — «чем вопрос назван», ВКЛЮЧАЯ явное имя (зеркало
//     domain.authoredLabel). Пусто = вопрос безымянен; на этом стоит блокер публикации
//     (publishGate.ts).
//   • derivedQuestionName — то же БЕЗ явного имени плюс последняя ступень «Тип N».
//     Стоит плейсхолдером поля имени в попапе: автор должен видеть, что уйдёт в
//     колонку, ПОКА поле пусто, — иначе «переопределение» означало бы «догадайся, что
//     переопределяешь» (ADR §10, решение 3).
//
// Расхождение, о котором надо знать: последнюю ступень («Тип N») Go собирает своей
// картой имён типов, а здесь берётся подпись типа из реестра редактора. Сегодня
// строки совпадают слово в слово; переименование подписи типа в редакторе разведёт их,
// и плейсхолдер станет обещать колонку с другим именем. Цена мала и ограничена
// вырожденным случаем — у вопроса нет ни заголовка, ни своего текста, ни подсказки, —
// а второе объявление имён типов на фронте стоило бы дороже: этап 16.1 их оттуда как
// раз и убирал.

// inheritedName — цепочка без явного имени: подпись группы → свой текст → плейсхолдер.
// Отдельной функцией, потому что оба входа выше используют её целиком, но по-разному:
// склеить их в один вызов значило бы поставить имя плейсхолдером самому себе.
function inheritedName(blocks: Block[], block: Block): string {
  // Подпись группы (title перебивает label) — тот же расчёт, которым живут превью и
  // рендерер, а не своя копия правила.
  const caption = groupMeta(blocks).get(block.groupId)?.caption ?? ''
  if (caption.trim() !== '') return caption
  // Собственный текст блока — у согласия это текст рядом с галочкой.
  const own = plainText(block.text)
  if (own.trim() !== '') return own
  const placeholder = block.settings?.placeholder ?? ''
  if (placeholder.trim() !== '') return placeholder
  return ''
}

export function authoredQuestionName(blocks: Block[], block: Block): string {
  const name = (block.name ?? '').trim()
  if (name !== '') return name
  return inheritedName(blocks, block)
}

export function derivedQuestionName(blocks: Block[], block: Block): string {
  const inherited = inheritedName(blocks, block)
  if (inherited !== '') return inherited
  // «Тип N»: N — позиция среди ОТВЕЧАЕМЫХ блоков, как её считает QuestionOrder.
  // Черновик — одна версия, поэтому нумерация совпадает с серверной; на форме с
  // историей версий Go считает по объединению версий, и разойтись они могут только
  // на вопросе, удалённом в свежей версии, — такого в редакторе на экране нет.
  const ordinal = blocks.filter((b) => isAnswerableType(b.type)).findIndex((b) => b.id === block.id)
  return `${editorKind(block.type).label} ${ordinal + 1}`
}
