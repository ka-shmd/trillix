import { type Period } from '../../shared/period'

// Фабрика query-ключей submissions: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md), только отсюда. Ключи вложены по formId — инвалидация
// ответов одной формы не трогает другие.
// Период — часть ключа сводки и счётчика: без него переключение окна отдавало бы
// кеш предыдущего, и экран молча показывал бы числа не того периода. Отсюда пары
// ключей: *AllPeriods — префикс на инвалидацию всех окон сразу (удалённый ответ
// обязан исчезнуть не только из открытого).
export const submissionKeys = {
  all: () => ['submissions'] as const,
  list: (formId: string) => ['submissions', 'list', formId] as const,
  summaryAllPeriods: (formId: string) => ['submissions', 'summary', formId] as const,
  summary: (formId: string, period: Period) => ['submissions', 'summary', formId, period] as const,
  countAllPeriods: (formId: string) => ['submissions', 'count', formId] as const,
  count: (formId: string, period: Period) => ['submissions', 'count', formId, period] as const,
}
