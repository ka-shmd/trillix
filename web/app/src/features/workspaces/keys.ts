// Фабрика query-ключей workspaces: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md), только через эту фабрику.
export const workspaceKeys = {
  list: () => ['workspaces', 'list'] as const,
  // Состав пространства ключуется его id: у каждого свой кэш, иначе переход
  // между пространствами показал бы чужих участников.
  members: (workspaceId: string) => ['workspaces', 'members', workspaceId] as const,
  // Ссылка-приглашение пространства: свой ключ, потому что живёт своей ручкой и
  // своим правом (member.manage), а состав читает и редактор.
  joinLink: (workspaceId: string) => ['workspaces', 'join-link', workspaceId] as const,
  joinPreview: (token: string) => ['workspaces', 'join-preview', token] as const,
}
