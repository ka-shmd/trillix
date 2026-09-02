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
// НАШ ТОЛЬКО ТЕКСТ ApiError: его пишет бэк по-русски и специально для автора
// («модель сейчас не отвечает, попробуйте ещё раз»). Сообщение любой другой
// ошибки приходит от браузера или рантайма и по-английски — `Failed to fetch`,
// `NetworkError when attempting to fetch resource`, — поэтому наружу оно не идёт
// никогда, вместо него подставляется fallback.
export function humanError(err: unknown, fallback = 'Что-то пошло не так. Попробуйте ещё раз.'): string {
  return err instanceof ApiError ? err.message : fallback
}
