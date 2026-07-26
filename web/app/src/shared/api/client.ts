import type { z } from 'zod'
import { CSRF_HEADER, csrfToken } from './csrf'
import { toApiError } from './errors'

const BASE = '/api/v1'

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

interface RequestOptions<T> {
  method?: Method
  body?: unknown
  // Схема валидирует успешный ответ на границе: непровалидированный any внутрь
  // приложения не проходит (web/CLAUDE.md). Отсутствует — тело не ожидается.
  schema?: z.ZodType<T>
}

// apiRequest — единственная точка выхода в приватный API. credentials:'include'
// шлёт cookie сессии; ошибки превращаются в ApiError; успех парсится Zod'ом.
export async function apiRequest<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') {
    const csrf = csrfToken()
    if (csrf) headers[CSRF_HEADER] = csrf
  }

  const res = await fetch(BASE + path, {
    method,
    credentials: 'include',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  if (!res.ok) throw await toApiError(res)
  if (res.status === 204 || !opts.schema) return undefined as T
  return opts.schema.parse(await res.json())
}
