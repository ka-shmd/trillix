// Фабрика query-ключей воронки: строковые литералы ключей в компонентах запрещены
// (web/CLAUDE.md), только отсюда. Ключ вложен по formId — инвалидация воронки одной
// формы не трогает другие.
export const funnelKeys = {
  all: () => ['funnel'] as const,
  detail: (formId: string) => ['funnel', formId] as const,
}
