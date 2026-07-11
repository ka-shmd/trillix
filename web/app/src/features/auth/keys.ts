// Фабрика query-ключей auth: строковые литералы ключей в компонентах запрещены
// (web/CLAUDE.md), только через эту фабрику.
export const authKeys = {
  me: () => ['auth', 'me'] as const,
}
