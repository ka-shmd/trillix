// Фабрика query-ключей расписаний: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md), только отсюда.
export const scheduleKeys = {
  // Список ключуется пространством: у каждого свой кэш, иначе переход между
  // пространствами показал бы чужие расписания.
  list: (workspaceId: string) => ['schedules', 'list', workspaceId] as const,
  detail: (scheduleId: string) => ['schedules', 'detail', scheduleId] as const,
  blocks: (scheduleId: string) => ['schedules', 'blocks', scheduleId] as const,
  bookings: (scheduleId: string) => ['schedules', 'bookings', scheduleId] as const,
  // Полотно ключуется ещё и отрезком: недели кэшируются по отдельности, и
  // листание назад не выбрасывает уже показанное. Правки инвалидируют префикс
  // calendarAll — какие именно недели затронуты, знать неоткуда.
  calendarAll: (scheduleId: string) => ['schedules', 'calendar', scheduleId] as const,
  calendar: (scheduleId: string, from: string, to: string) =>
    ['schedules', 'calendar', scheduleId, from, to] as const,
}
