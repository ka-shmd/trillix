// Фабрика query-ключей документов и согласий: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md).
export const legalKeys = {
  consents: () => ['legal', 'consents'] as const,
}
