// Фабрика query-ключей workspaces: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md), только через эту фабрику.
export const workspaceKeys = {
  list: () => ['workspaces', 'list'] as const,
}
