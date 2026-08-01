import { type BlockKindContract, type SchemaIssue } from './contract'
import {
  DEFAULT_SCALE_MAX,
  DEFAULT_SCALE_MIN,
  SCALE_LOWER_BOUND,
  SCALE_UPPER_BOUND,
} from './limits'
import { type Settings } from './settings'

// scaleRange — диапазон шкалы блока с фолбэком на дефолт, если схема его не несёт.
// Зеркалит scaleRange в Go. Общий для контрола поля, редактора и валидации ответа.
//
// Параметр структурный, а не Block: файл типа лежит НИЖЕ formSchema.ts в дереве
// импортов (formSchema собирает реестр), поэтому импорт Block сюда замкнул бы цикл.
// Вызывающие продолжают передавать блок как есть.
export const scaleRange = (b: {
  settings?: { scaleMin?: number; scaleMax?: number }
}): { min: number; max: number } => {
  const { scaleMin, scaleMax } = b.settings ?? {}
  return scaleMin !== undefined && scaleMax !== undefined
    ? { min: scaleMin, max: scaleMax }
    : { min: DEFAULT_SCALE_MIN, max: DEFAULT_SCALE_MAX }
}

// Правила диапазона. Замечание отдаётся ОДНО за раз (цепочка else if, как до фазы 16):
// «оба конца» и «в границах» — условия одного правила, и вываливать их разом значит
// показать автору два сообщения об одной ошибке.
//
// «Ни одного конца» — валидное состояние: недособранный черновик, как choice без
// опций. Отсюда и порядок: сначала проверяем, задан ли хоть один.
const scaleIssues = (s: Settings): SchemaIssue[] => {
  const { scaleMin, scaleMax } = s
  if (scaleMin === undefined && scaleMax === undefined) return []
  if (scaleMin === undefined || scaleMax === undefined) {
    return [{ message: 'шкала: нужны оба конца диапазона', path: ['settings'] }]
  }
  if (scaleMin < SCALE_LOWER_BOUND || scaleMax > SCALE_UPPER_BOUND) {
    return [
      {
        message: `шкала: диапазон вне [${SCALE_LOWER_BOUND}, ${SCALE_UPPER_BOUND}]`,
        path: ['settings'],
      },
    ]
  }
  if (scaleMin >= scaleMax) {
    return [{ message: 'шкала: минимум не меньше максимума', path: ['settings'] }]
  }
  return []
}

// Оценка по шкале — ряд кнопок от min до max (1–5 по умолчанию, NPS 0–10). Ответ
// хранится строкой, как у числа и даты.
export const scale: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: ['scaleMin', 'scaleMax'],
  // Плейсхолдера у ряда кнопок нет: вводить нечего.
  supportsPlaceholder: false,
  // Шкала без вопроса не читается вовсе — ряд цифр без подписи ничего не значит.
  requiresCaption: true,
  issues: scaleIssues,
}
