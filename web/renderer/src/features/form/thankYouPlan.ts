import { DEFAULT_THANK_YOU_TEXT, isHttpUrl } from '@entities/formSchema'

// Пауза перед переходом, когда владелец задал и текст, и ссылку: человек успевает
// прочитать благодарность. Без своего текста читать нечего — уходим сразу.
export const REDIRECT_DELAY_MS = 2000

export type ThankYouPlan = {
  // Что показать под заголовком: текст владельца или дефолтная заглушка.
  message: string
  // Куда уйти после отправки; null — перехода нет (не задан или не прошёл проверку).
  target: string | null
  // Через сколько уйти. 0 — немедленно (читать нечего).
  delayMs: number
}

// planThankYou — всё решение экрана «после отправки» одной чистой функцией: что
// показать, уходить ли и когда. Держится отдельно от компонента, чтобы ветки
// проверялись юнитами без DOM (у рендерера нет testing-library — список
// зависимостей заморожен, а бюджет 95 КиБ не резиновый).
//
// Про безопасность: redirectUrl уже проверен сервером (ValidateSchema отвергает
// всё, кроме абсолютного http(s)), но проверяется здесь ещё раз — значение уходит
// в window.location, и доверять содержимому схемы на месте использования нельзя
// (инвариант 4).
export function planThankYou(text: string, redirectUrl: string): ThankYouPlan {
  const custom = text.trim()
  const target = isHttpUrl(redirectUrl) ? redirectUrl : null
  return {
    message: custom || DEFAULT_THANK_YOU_TEXT,
    target,
    delayMs: custom ? REDIRECT_DELAY_MS : 0,
  }
}
