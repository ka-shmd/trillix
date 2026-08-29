import { isAnswerableType, type Block } from '@entities/formSchema'
import { type Answer } from '@fields/answer'

// Автопереход на следующую страницу (колонка forms.auto_jump, 0044): человек выбрал
// вариант — форма листается сама, без «Далее».
//
// РАБОТАЕТ НЕ ВЕЗДЕ, и это не ограничение реализации, а условие, при котором приём
// вообще осмыслен. Нужны два совпадения сразу:
//
//   1. На странице РОВНО ОДИН отвечаемый вопрос. Со вторым прыжок унёс бы человека от
//      вопроса, который он ещё не видел.
//   2. Ответ даётся ВЫБОРОМ — один из списка, выпадающий список, шкала. У текста,
//      почты и числа нет момента «ответ дан»: каждая набранная буква выглядела бы
//      законченным ответом, и форма улетала бы вперёд посреди слова.
//
// Пустой ответ (снятый выбор) не листает: это не ответ, а его отмена.
const JUMPING_TYPES = new Set(['single_choice', 'dropdown', 'scale'])

// Пауза перед переходом. Страница, исчезающая в тот же миг, читается как сбой:
// человек не успевает увидеть, что выбор принят. Четверть секунды — ровно столько,
// чтобы отметка успела появиться, и не столько, чтобы её ждали.
export const AUTO_JUMP_DELAY = 250

export function shouldAutoJump(pageBlocks: Block[], changed: Block, value: Answer): boolean {
  if (!JUMPING_TYPES.has(changed.type)) return false
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return false
  }
  return pageBlocks.filter((b) => isAnswerableType(b.type)).length === 1
}
