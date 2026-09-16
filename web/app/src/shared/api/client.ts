import type { z } from 'zod'
import { CSRF_HEADER, csrfToken } from './csrf'
import { toApiError } from './errors'

const BASE = '/api/v1'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface RequestOptions<T> {
  method?: Method
  // FormData едет как есть (файл), всё остальное — JSON'ом. Content-Type у
  // FormData не ставится намеренно: его выставляет браузер вместе с boundary,
  // и заданный руками ломает разбор multipart на сервере.
  body?: unknown
  // Схема валидирует успешный ответ на границе: непровалидированный any внутрь
  // приложения не проходит (web/CLAUDE.md). Отсутствует — тело не ожидается.
  schema?: z.ZodType<T>
  // signal — отмена запроса. Нужна там, где ответа можно не дождаться: человек
  // закрыл окно, а запрос к чужому API висит до своего таймаута и держит
  // соединение браузера (их на origin шесть). React Query отдаёт такой signal
  // сам — достаточно дотащить его сюда.
  signal?: AbortSignal
}

// apiRequest — единственная точка выхода в приватный API. credentials:'include'
// шлёт cookie сессии; ошибки превращаются в ApiError; успех парсится Zod'ом.
export async function apiRequest<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {}
  const isForm = opts.body instanceof FormData
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') {
    const csrf = csrfToken()
    if (csrf) headers[CSRF_HEADER] = csrf
  }

  const res = await fetch(BASE + path, {
    method,
    credentials: 'include',
    headers,
    signal: opts.signal,
    body: isForm ? (opts.body as FormData) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  if (!res.ok) throw await toApiError(res)
  if (res.status === 204 || !opts.schema) return undefined as T
  return opts.schema.parse(await res.json())
}
