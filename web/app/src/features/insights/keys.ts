import { type Period } from '../../shared/period'

// Фабрика query-ключей аналитики: строковые литералы ключей в компонентах запрещены
// (web/CLAUDE.md), только отсюда.
//
// Период — ЧАСТЬ ключа: без него переключение окна отдавало бы кеш предыдущего, и
// экран показывал бы числа не того периода, который выбран, — молча.
export const insightsKeys = {
  all: () => ['insights'] as const,
  // Сегмент — тоже часть ключа; '' — «все визиты».
  visits: (formId: string, period: Period, segments: string[] = []) =>
    ['insights', 'visits', formId, period, segments] as const,
  versions: (formId: string, period: Period, segments: string[] = []) =>
    ['insights', 'versions', formId, period, segments] as const,
  breakdown: (formId: string, period: Period) => ['insights', 'breakdown', formId, period] as const,
  crosstab: (
    formId: string,
    period: Period,
    rows: string,
    cols: string,
    where = '',
    segments: string[] = [],
  ) => ['insights', 'crosstab', formId, period, rows, cols, where, segments] as const,
}
