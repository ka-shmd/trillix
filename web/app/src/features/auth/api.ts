import { z } from 'zod'
import { apiRequest } from '../../shared/api/client'
import { userSchema, type User } from '../../entities/user'
import type { Credentials } from './validation'

// Ответ /auth/providers. Схема на границе: неизвестное имя провайдера не должно
// молча превратиться в кнопку, ведущую в 404.
const providersSchema = z.object({ providers: z.array(z.string()) })

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

// Сброс пароля. Обе ручки отвечают 204 без тела: forgot — одинаково для любого
// адреса (существование аккаунта не раскрывается), reset — после смены пароля.
export function forgotPassword(body: { email: string }): Promise<void> {
  return apiRequest('/auth/forgot-password', { method: 'POST', body })
}

export function resetPassword(body: { token: string; password: string }): Promise<void> {
  return apiRequest('/auth/reset-password', { method: 'POST', body })
}

// Подтверждение email. verify — публичная (токен из письма = аутентификация),
// resend — за сессией (кнопка в баннере кабинета). Обе отвечают 204 без тела.
export function verifyEmail(body: { token: string }): Promise<void> {
  return apiRequest('/auth/verify-email', { method: 'POST', body })
}

export function resendVerification(): Promise<void> {
  return apiRequest('/auth/resend-verification', { method: 'POST' })
}

// Настройки аккаунта — /api/v1/account/*. Живут в фиче auth, а не в своей:
// они правят того же самого текущего пользователя, чей профиль (me) здесь и
// лежит, а импорт одной фичи из другой запрещён (web/CLAUDE.md).
//
// Оба поля шлются всегда: пустая строка означает «стереть».
export function updateProfile(body: { firstName: string; lastName: string }): Promise<User> {
  return apiRequest('/account/profile', { method: 'PATCH', body, schema: userSchema })
}

// Список включённых провайдеров. Пустой — ключей нет в окружении бэка,
// кнопки не рисуем (мёртвая кнопка хуже отсутствующей).
export function getProviders(): Promise<string[]> {
  return apiRequest('/auth/providers', { schema: providersSchema }).then((r) => r.providers)
}

// Второй шаг привязки: адрес занят, доказываем владение паролем. Cookie
// oauth_pending ставит бэк на колбэке, JS её не видит и не шлёт руками.
export function linkProvider(body: Credentials): Promise<User> {
  return apiRequest('/auth/oauth/link', { method: 'POST', body, schema: userSchema })
}

// Ссылка ухода к провайдеру. Именно href, а не fetch: нужен полноценный переход
// браузера, XHR за редиректом на чужой домен не пойдёт.
export function providerStartUrl(provider: string): string {
  return `/api/v1/auth/oauth/${provider}/start`
}
