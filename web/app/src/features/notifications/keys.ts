// Фабрика query-ключей уведомлений: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md), только отсюда.
export const notificationKeys = {
  feed: () => ['notifications', 'feed'] as const,
}
