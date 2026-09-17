// Фабрика query-ключей документов и согласий: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md).
export const legalKeys = {
  consents: () => ['legal', 'consents'] as const,
  signupProfile: () => ['legal', 'signup-profile'] as const,
  documents: () => ['legal', 'documents'] as const,
  // version: '' — действующая редакция.
  document: (kind: string, version: string) => ['legal', 'documents', kind, version] as const,
}
