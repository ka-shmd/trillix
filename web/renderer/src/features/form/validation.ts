import { z } from 'zod'

import { type Block, isContentType, isValidPhone, markRange } from '@entities/formSchema'
import { type Answer } from '@fields/answer'
import { isEmptyAnswer } from '@fields/required'

import { type Answers } from './answers'

// Клиентская проверка ответов по описанию блоков — required и формат (email/число/
// дата). Зеркалит будущий серверный ValidateAnswers (фаза 5), который останется
// финальной инстанцией; здесь — быстрая подсказка респонденту. Карта blockId →
// человекочитаемое сообщение, только для невалидных полей.
export type Errors = Record<string, string>

const REQUIRED = 'Обязательное поле'

const emailCheck = z.email()

// Проверка одного блока: null — ок. Пустое необязательное поле валидно; формат
// проверяется только у заполненного значения.
//
// required передаётся ОТДЕЛЬНО от блока (фаза 21): обязательность стала свойством не
// документа, а плана — у блока может стоять requiredIf, и решает его сработавшее
// условие. Без аргумента берётся флаг блока, то есть поведение до фазы.
export function validateBlock(
  block: Block,
  value: Answer | undefined,
  required = block.required === true,
): string | null {
  // Неотвечаемый блок (text) не собирает ответ — всегда валиден.
  if (isContentType(block.type)) return null
  if (isEmptyAnswer(value)) {
    return required ? REQUIRED : null
  }
  // Дальше значение непустое. Формат — только у текстовых типов (choice-значения
  // приходят из готовых вариантов, отдельный формат не нужен).
  const text = typeof value === 'string' ? value : ''
  switch (block.type) {
    case 'email':
      return emailCheck.safeParse(text).success ? null : 'Некорректный email'
    case 'phone':
      // Мягко: символы и число цифр, не формат страны (зеркалит validPhone в Go).
      return isValidPhone(text) ? null : 'Некорректный телефон'
    case 'number':
      return Number.isFinite(Number(text)) ? null : 'Введите число'
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text))
        ? null
        : 'Некорректная дата'
    case 'scale':
    case 'rating': {
      // Значение приходит только с кнопок деления, поэтому промах возможен лишь у
      // подделанного тела — но клиент обязан зеркалить сервер (validateScaleAnswer).
      const { min, max } = markRange(block)
      const n = Number(text)
      return Number.isInteger(n) && n >= min && n <= max ? null : `Выберите значение ${min}–${max}`
    }
    default:
      return null
  }
}

// Проверка всей формы: собирает только ошибки (валидные блоки в карту не попадают).
//
// blocks — то, что респондент ВИДИТ (страница или плоский план), а не весь документ:
// скрытый условием вопрос не спрашивали, и ошибка по нему указывала бы на невидимое.
// required — множество фактически обязательных из плана; без него берутся флаги блоков.
export function validateAll(
  blocks: readonly Block[],
  answers: Answers,
  required?: ReadonlySet<string>,
): Errors {
  const errors: Errors = {}
  for (const block of blocks) {
    const msg = validateBlock(block, answers[block.id], required?.has(block.id) ?? block.required === true)
    if (msg) errors[block.id] = msg
  }
  return errors
}
