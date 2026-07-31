import { isCaptionType, isChoiceType, isAnswerableType, plainText, type Block } from '@entities/formSchema'

import { authoredQuestionName } from './questionName'

// Гейт публикации — ЗЕРКАЛО internal/domain/publish.go (ADR §10, решение 5). Правится
// тем же PR, тесты обеих сторон.
//
// Зачем зеркало, если правило доменное и Go всё равно ответит 422: кабинету тот же
// список нужен ДО нажатия — чтобы не отправлять заведомо отказную публикацию и чтобы
// показать автору, ГДЕ именно чинить, с переходом на строку. Финальная инстанция
// остаётся за Go: публикация мимо кабинета проходит через него же.
//
// Живёт в билдере, а не в @entities, осознанно: это правило ПУБЛИКАЦИИ, а не схемы, и
// потребитель у него один — кабинет. Рендерер публикацией не занимается, и класть
// правило на его сторону импортов значило бы рисковать бюджетом ради чужого кода.

export type PublishBlockerKind = 'unnamed_question' | 'empty_caption' | 'choice_without_options'

export type PublishBlocker = {
  // blockId — адрес: по нему кабинет переводит каретку на строку. Блокер без адреса
  // бесполезен, поэтому поле обязательное.
  blockId: string
  kind: PublishBlockerKind
  message: string
}

// Сообщения — те же строки, что в Go: автор увидит одинаковый текст, дошёл ли он до
// отказа сервера или прочитал список в кабинете.
const MESSAGES: Record<PublishBlockerKind, string> = {
  unnamed_question: 'у вопроса нет имени: впишите заголовок или задайте имя в настройках блока',
  empty_caption: 'пустая подпись: впишите текст вопроса или удалите строку',
  choice_without_options: 'в списке нет ни одного варианта: добавьте хотя бы один',
}

// publishBlockers — причины, по которым форму нельзя опубликовать, в порядке
// документа. Пустой список = публиковать можно. Пустая форма блокеров не даёт: форма
// без единого вопроса — законный документ (страница с одним текстом).
export function publishBlockers(blocks: Block[]): PublishBlocker[] {
  const out: PublishBlocker[] = []
  const add = (blockId: string, kind: PublishBlockerKind) =>
    out.push({ blockId, kind, message: MESSAGES[kind] })

  for (const b of blocks) {
    // Проверки независимы: блок, нарушивший два правила, обязан дать два замечания —
    // «почините одно, узнаете про второе» это ровно то, чего список и избегает.
    if (isAnswerableType(b.type) && authoredQuestionName(blocks, b) === '') {
      add(b.id, 'unnamed_question')
    }
    if (isCaptionType(b.type) && plainText(b.text).trim() === '') {
      add(b.id, 'empty_caption')
    }
    if (isChoiceType(b.type) && (b.settings?.options?.length ?? 0) === 0) {
      add(b.id, 'choice_without_options')
    }
  }
  return out
}
