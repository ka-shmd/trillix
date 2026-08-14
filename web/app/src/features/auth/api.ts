import { z } from 'zod'
import { apiRequest } from '../../shared/api/client'
import { userSchema, type User } from '../../entities/user'
import { identitySchema, type Identity } from '../../entities/identity'
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

// Ответ входа — либо пользователь, либо «нужен второй фактор» (фаза 23,
// слайс F): сессия во втором случае НЕ выдана, и объекта пользователя нет.
// Union на границе, а не необязательные поля: два разных исхода не должны
// притворяться одним объектом с половиной пустых полей.
const twoFactorRequiredSchema = z.object({ twoFactorRequired: z.literal(true) })
const loginResultSchema = z.union([twoFactorRequiredSchema, userSchema])

export type LoginResult = z.infer<typeof loginResultSchema>

export function isTwoFactorRequired(r: LoginResult): r is { twoFactorRequired: true } {
  return 'twoFactorRequired' in r
}

export function login(body: Credentials): Promise<LoginResult> {
  return apiRequest('/auth/login', { method: 'POST', body, schema: loginResultSchema })
}

// Второй шаг входа. Пропуск лежит в HttpOnly-cookie, которую поставил первый
// шаг: JS её не видит и не шлёт руками.
export function loginTwoFactor(body: { code: string }): Promise<User> {
  return apiRequest('/auth/login-2fa', { method: 'POST', body, schema: userSchema })
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

// Смена пароля. Ответ 204 без тела: бэк рвёт все сессии и ставит cookie новой —
// клиенту ловить нечего, кроме успеха.
export function changePassword(body: { currentPassword: string; newPassword: string }): Promise<void> {
  return apiRequest('/account/password', { method: 'POST', body })
}

// Смена адреса — два шага. Первый (за сессией) только ставит письма в очередь:
// адрес аккаунта не меняется, пока не перейдут по ссылке. Второй — публичный,
// аутентифицирует сам токен из письма.
export function requestEmailChange(body: {
  newEmail: string
  currentPassword: string
}): Promise<void> {
  return apiRequest('/account/email', { method: 'POST', body })
}

export function confirmEmailChange(body: { token: string }): Promise<void> {
  return apiRequest('/auth/confirm-email-change', { method: 'POST', body })
}

// Способы входа аккаунта (фаза 23, слайс E).
export function getIdentities(): Promise<Identity[]> {
  return apiRequest('/account/identities', { schema: z.array(identitySchema) })
}

export function unlinkIdentity(provider: string): Promise<void> {
  return apiRequest(`/account/identities/${provider}`, { method: 'DELETE' })
}

// Привязка начинается ПЕРЕХОДОМ, а не fetch'ем: браузеру нужно уйти к
// провайдеру и вернуться, а XHR за редиректом на чужой домен не пойдёт. Адрес
// свой, а не /auth/oauth/{p}/start: тот публичный (им входят), этот за сессией
// и ставит подписанное намерение привязки.
export function identityLinkUrl(provider: string): string {
  return `/api/v1/account/identities/${provider}/start`
}

// Второй фактор в настройках (фаза 23, слайс F).
export function setupTwoFactor(): Promise<{ secret: string; otpauthUrl: string }> {
  return apiRequest('/account/2fa/setup', {
    method: 'POST',
    schema: z.object({ secret: z.string(), otpauthUrl: z.string() }),
  })
}

export function enableTwoFactor(body: { code: string }): Promise<string[]> {
  return apiRequest('/account/2fa/enable', {
    method: 'POST',
    body,
    schema: z.object({ recoveryCodes: z.array(z.string()) }),
  }).then((r) => r.recoveryCodes)
}

export function disableTwoFactor(body: { currentPassword: string; code: string }): Promise<void> {
  return apiRequest('/account/2fa/disable', { method: 'POST', body })
}

// Удаление аккаунта (фаза 23, слайс G). POST, а не DELETE: у запроса есть тело
// с подтверждением. Ответ 204 — cookie сессии бэк гасит сам.
export function deleteAccount(body: { currentPassword: string; code: string }): Promise<void> {
  return apiRequest('/account/delete', { method: 'POST', body })
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
