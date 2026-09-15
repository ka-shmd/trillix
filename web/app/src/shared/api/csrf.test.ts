import { describe, expect, it } from 'vitest'

import { readCsrfToken } from './csrf'

// Имя CSRF-cookie зависит от контура: `__Host-csrf_token` с флагом Secure,
// `csrf_token` в dev по http (ADR §10).
describe('CSRF-токен из cookie', () => {
  it('на прод-контуре берётся cookie с префиксом __Host-', () => {
    expect(readCsrfToken('__Host-session=x; __Host-csrf_token=abc')).toBe('abc')
  })

  it('в dev по http берётся cookie без префикса', () => {
    expect(readCsrfToken('session=x; csrf_token=abc')).toBe('abc')
  })

  it('подложенная cookie без префикса не перебивает префиксную', () => {
    // Порядок в document.cookie задаёт браузер: подложенная с соседнего поддомена
    // cookie может стоять первой.
    expect(readCsrfToken('csrf_token=evil; __Host-csrf_token=abc')).toBe('abc')
  })

  it('без cookie токена нет', () => {
    expect(readCsrfToken('')).toBeUndefined()
  })
})
