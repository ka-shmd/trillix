import { z } from 'zod'

// Единый формат ошибок API (ARCHITECTURE §4.4): { error: { code, message, fields? } }.
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
})

// ApiError — типизированный отказ бэка. Компоненты различают ветки по code
// (invalid_credentials / email_taken / validation_failed), а не по тексту.
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly fields?: Record<string, string>

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.fields = fields
  }
}

// toApiError разбирает тело ответа-ошибки в ApiError; на неожиданном формате
// (например, 502 без JSON) отдаёт универсальный ApiError, не роняя парсингом.
export async function toApiError(res: Response): Promise<ApiError> {
  try {
    const parsed = errorEnvelopeSchema.safeParse(await res.json())
    if (parsed.success) {
      const { code, message, fields } = parsed.data.error
      return new ApiError(res.status, code, message, fields)
    }
  } catch {
    // тело не JSON — падаем на универсальную ошибку ниже
  }
  return new ApiError(res.status, 'unknown', 'Что-то пошло не так. Попробуйте ещё раз.')
}

// humanError — текст отказа для показа человеку.
//
// ⚠ ТЕКСТ БЭКА ПРИГОДЕН НЕ ВСЕГДА. Человеческое сообщение он пишет только у
// «обёрнутых» отказов (`wrappedSentinels` в respond.go: валидация, конфликт, тариф,
// закрытая форма, недоступность). У остальных message РАВЕН КОДУ и приходит
// латиницей — `unauthorized`, `not_found`, `forbidden`, `internal`. До экрана такое
// доезжать не должно: в интерфейсе только русский текст, написанный нами (решение
// владельца). Поймано на отмене записи, где отказ показался словом «unauthorized».
//
// Сообщение любой НЕ-ApiError приходит от браузера или рантайма и тоже по-английски
// («Failed to fetch»), поэтому наружу не идёт никогда.
//
// Проверка на кириллицу, а не список кодов: коды заводятся на бэке, и второй их
// список здесь разъехался бы с первым молча. Наши человеческие тексты по-русски по
// правилу, машинные коды — латиницей, и это различие устойчивее перечисления.
const BY_CODE: Record<string, string> = {
  unauthorized: 'Сессия истекла — войдите заново.',
  invalid_credentials: 'Неверная почта или пароль.',
  forbidden: 'Недостаточно прав для этого действия.',
  not_found: 'Не найдено — возможно, это уже удалили.',
  rate_limited: 'Слишком часто. Подождите немного и попробуйте снова.',
  payload_too_large: 'Слишком большой запрос.',
}

export function humanError(
  err: unknown,
  fallback = 'Что-то пошло не так. Попробуйте ещё раз.',
): string {
  if (!(err instanceof ApiError)) return fallback
  if (/[а-яё]/i.test(err.message)) return err.message
  return BY_CODE[err.code] ?? fallback
}
