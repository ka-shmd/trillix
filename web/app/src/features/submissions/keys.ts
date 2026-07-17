// Фабрика query-ключей submissions: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md), только отсюда. Ключи вложены по formId — инвалидация
// ответов одной формы не трогает другие.
export const submissionKeys = {
  all: () => ['submissions'] as const,
  list: (formId: string) => ['submissions', 'list', formId] as const,
  summary: (formId: string) => ['submissions', 'summary', formId] as const,
}
