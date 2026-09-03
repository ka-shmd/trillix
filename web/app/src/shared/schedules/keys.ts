// Фабрика query-ключей расписаний: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md), только отсюда.
export const scheduleKeys = {
  // Список ключуется пространством: у каждого свой кэш, иначе переход между
  // пространствами показал бы чужие расписания.
  list: (workspaceId: string) => ['schedules', 'list', workspaceId] as const,
  detail: (scheduleId: string) => ['schedules', 'detail', scheduleId] as const,
  blocks: (scheduleId: string) => ['schedules', 'blocks', scheduleId] as const,
  bookings: (scheduleId: string) => ['schedules', 'bookings', scheduleId] as const,
}
