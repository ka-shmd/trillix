// Фабрика query-ключей forms: строковые литералы ключей в компонентах запрещены
// (web/CLAUDE.md), только отсюда.
export const formKeys = {
  all: () => ['forms'] as const,
  list: () => ['forms', 'list'] as const,
  detail: (id: string) => ['forms', 'detail', id] as const,
}
