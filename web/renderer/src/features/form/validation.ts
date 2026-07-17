import { z } from 'zod'

import { type Block, isContentType, isValidPhone, scaleRange } from '@entities/formSchema'
import { type Answer } from '@fields/answer'

import { type Answers } from './answers'

// Клиентская проверка ответов по описанию блоков — required и формат (email/число/
// дата). Зеркалит будущий серверный ValidateAnswers (фаза 5), который останется
// финальной инстанцией; здесь — быстрая подсказка респонденту. Карта blockId →
// человекочитаемое сообщение, только для невалидных полей.
export type Errors = Record<string, string>

const REQUIRED = 'Обязательное поле'

const emailCheck = z.email()

function isEmpty(value: Answer | undefined): boolean {
  if (value == null || value === '') return true
  return Array.isArray(value) && value.length === 0
}

// Проверка одного блока: null — ок. Пустое необязательное поле валидно; формат
// проверяется только у заполненного значения.
export function validateBlock(block: Block, value: Answer | undefined): string | null {
  // Неотвечаемый блок (text) не собирает ответ — всегда валиден.
  if (isContentType(block.type)) return null
  if (isEmpty(value)) {
    return block.required ? REQUIRED : null
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
    case 'scale': {
      // Значение приходит только с кнопок деления, поэтому промах возможен лишь у
      // подделанного тела — но клиент обязан зеркалить сервер (validateScaleAnswer).
      const { min, max } = scaleRange(block)
      const n = Number(text)
      return Number.isInteger(n) && n >= min && n <= max ? null : `Выберите значение ${min}–${max}`
    }
    default:
      return null
  }
}

// Проверка всей формы: собирает только ошибки (валидные блоки в карту не попадают).
export function validateAll(blocks: readonly Block[], answers: Answers): Errors {
  const errors: Errors = {}
  for (const block of blocks) {
    const msg = validateBlock(block, answers[block.id])
    if (msg) errors[block.id] = msg
  }
  return errors
}
