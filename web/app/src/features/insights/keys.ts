import { type Period } from '../../shared/period'

// Фабрика query-ключей аналитики: строковые литералы ключей в компонентах запрещены
// (web/CLAUDE.md), только отсюда.
//
// Период — ЧАСТЬ ключа: без него переключение окна отдавало бы кеш предыдущего, и
// экран показывал бы числа не того периода, который выбран, — молча.
export const insightsKeys = {
  all: () => ['insights'] as const,
  visits: (formId: string, period: Period) => ['insights', 'visits', formId, period] as const,
  breakdown: (formId: string, period: Period) =>
    ['insights', 'breakdown', formId, period] as const,
}
