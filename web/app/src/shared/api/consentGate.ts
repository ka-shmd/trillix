import { ApiError } from './errors'

// Гейт согласия (docs/design/signup-consent.md §3.2): пока действующая редакция
// Пользовательского соглашения не принята, приватный API отвечает 403 consent_required,
// и кабинет уводит на экран согласия, запомнив, куда человек шёл.

export const WELCOME_PATH = '/welcome'

export function isConsentRequired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'consent_required'
}

// safeRedirect — куда вернуть человека после экрана согласия. Только путь этого же
// кабинета: адрес приезжает параметром, и без проверки экран согласия стал бы открытым
// редиректом на чужой сайт («//evil.example» браузер читает как адрес другого хоста).
export function safeRedirect(target: string | undefined): string {
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return '/'
  if (target === WELCOME_PATH || target.startsWith(WELCOME_PATH + '?')) return '/'
  return target
}

// consentRedirectFor — куда увести по отказу API: на экран согласия с возвратом на
// текущий адрес, или никуда (отказ другой либо человек уже на экране согласия).
export function consentRedirectFor(
  err: unknown,
  location: { pathname: string; href: string },
): { redirect: string } | null {
  if (!isConsentRequired(err) || location.pathname === WELCOME_PATH) return null
  return { redirect: safeRedirect(location.href) }
}
