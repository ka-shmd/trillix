import type { z } from 'zod'
import { toApiError } from './errors'

const BASE = '/api/v1'
const CSRF_COOKIE = 'csrf_token'
const CSRF_HEADER = 'X-CSRF-Token'

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

interface RequestOptions<T> {
  method?: Method
  body?: unknown
  // Схема валидирует успешный ответ на границе: непровалидированный any внутрь
  // приложения не проходит (web/CLAUDE.md). Отсутствует — тело не ожидается.
  schema?: z.ZodType<T>
}

// readCookie достаёт csrf_token, выданный при логине (double-submit): его кладём
// в заголовок на мутирующих запросах. Cookie сессии — httpOnly, JS её не видит.
function readCookie(name: string): string | undefined {
  const prefix = `${name}=`
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length))
  }
  return undefined
}

// apiRequest — единственная точка выхода в приватный API. credentials:'include'
// шлёт cookie сессии; ошибки превращаются в ApiError; успех парсится Zod'ом.
export async function apiRequest<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE)
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
