import { apiRequest } from '../../shared/api/client'
import { userSchema, type User } from '../../entities/user'
import type { Credentials } from './validation'

// Транспорт auth: каждый ответ парсится userSchema на границе, logout тела не
// возвращает (204).
export function getMe(): Promise<User> {
  return apiRequest('/auth/me', { schema: userSchema })
}

export function register(body: Credentials): Promise<User> {
  return apiRequest('/auth/register', { method: 'POST', body, schema: userSchema })
}

export function login(body: Credentials): Promise<User> {
  return apiRequest('/auth/login', { method: 'POST', body, schema: userSchema })
}

export function logout(): Promise<void> {
  return apiRequest('/auth/logout', { method: 'POST' })
}
