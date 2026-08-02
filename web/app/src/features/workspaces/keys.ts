// Фабрика query-ключей workspaces: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md), только через эту фабрику.
export const workspaceKeys = {
  list: () => ['workspaces', 'list'] as const,
  // Состав пространства ключуется его id: у каждого свой кэш, иначе переход
  // между пространствами показал бы чужих участников.
  members: (workspaceId: string) => ['workspaces', 'members', workspaceId] as const,
  invitation: (token: string) => ['workspaces', 'invitation', token] as const,
}
