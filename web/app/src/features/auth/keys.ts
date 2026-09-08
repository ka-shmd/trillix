// Фабрика query-ключей auth: строковые литералы ключей в компонентах запрещены
// (web/CLAUDE.md), только через эту фабрику.
export const authKeys = {
  me: () => ['auth', 'me'] as const,
  identities: () => ['auth', 'identities'] as const,
  devices: () => ['auth', 'devices'] as const,
}

export const oauthKeys = {
  providers: () => ['auth', 'oauth', 'providers'] as const,
}
