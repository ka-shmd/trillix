import { type Period } from '../../shared/period'

// Фабрика query-ключей воронки: строковые литералы ключей в компонентах запрещены
// (web/CLAUDE.md), только отсюда. Ключ вложен по formId — инвалидация воронки одной
// формы не трогает другие.
export const funnelKeys = {
  all: () => ['funnel'] as const,
  // Период — часть ключа: иначе переключение окна отдаёт кеш предыдущего.
  // Сегмент — тоже: '' — «все визиты».
  detail: (formId: string, period: Period, segment = '') =>
    ['funnel', formId, period, segment] as const,
}
