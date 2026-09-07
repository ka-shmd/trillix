// Фабрика query-ключей тарифа: строковые литералы ключей в компонентах запрещены
// (web/CLAUDE.md).
export const planKeys = {
  snapshot: (workspaceId: string) => ['plan', 'snapshot', workspaceId] as const,
  account: () => ['plan', 'account'] as const,
}
