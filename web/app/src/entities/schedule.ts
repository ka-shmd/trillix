import { z } from 'zod'

// Расписание записи на время (фаза 27, docs/design/booking.md). Единственный
// источник типа — эта схема (web/CLAUDE.md); Go-зеркало — internal/domain/booking.go.

// Потолки зеркалят домен Go. Расходиться им нельзя: поле, дающее набрать больше,
// чем примет сервер, врёт.
export const MAX_SCHEDULE_NAME_LEN = 100
export const MAX_WINDOWS_PER_DAY = 12
export const MAX_SCHEDULE_EXCEPTIONS = 200
export const MAX_SCHEDULE_NOTE_LEN = 200

// Ключи дней недели — те же, что в JSONB правила (порядок time.Weekday в Go).
// Порядок ЗДЕСЬ — недельный, с понедельника: экран читается календарём, а не
// перечислением ключей.
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export const WEEKDAY_TITLES: Record<Weekday, string> = {
  mon: 'Понедельник',
  tue: 'Вторник',
  wed: 'Среда',
  thu: 'Четверг',
  fri: 'Пятница',
  sat: 'Суббота',
  sun: 'Воскресенье',
}

// Будни — для кнопки «скопировать на все будни»: без неё автор заполняет одно и
// то же пять раз.
export const WEEKDAYS_WORKING: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri']

export const windowSchema = z.object({
  // Время МЕСТНОЕ для расписания, строкой «ЧЧ:ММ». Не UTC: «понедельник, 10:00»
  // означает 10:00 у автора всегда.
  from: z.string(),
  to: z.string(),
})
export type TimeWindow = z.infer<typeof windowSchema>

export const scheduleExceptionSchema = z.object({
  date: z.string(), // ГГГГ-ММ-ДД в поясе расписания
  windows: z.array(windowSchema),
})
export type ScheduleException = z.infer<typeof scheduleExceptionSchema>

export const availabilitySchema = z.object({
  weekly: z.record(z.string(), z.array(windowSchema)),
  exceptions: z.array(scheduleExceptionSchema),
})
export type Availability = z.infer<typeof availabilitySchema>

export const scheduleSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  timezone: z.string(),
  availability: availabilitySchema,
  slotMinutes: z.number().int(),
  // bufferMinutes входит в ШАГ сетки, но не в длительность встречи: приём 60 с
  // буфером 10 даёт старты 10:00, 11:10, 12:20.
  bufferMinutes: z.number().int(),
  horizonDays: z.number().int(),
  leadMinutes: z.number().int(),
  capacity: z.number().int(),
  maxSeatsPerBooking: z.number().int(),
  // showRemaining управляет только ПОКАЗОМ остатка: пикеру число нужно всегда,
  // иначе он не погасит слот, куда запрошенные места не влезают.
  showRemaining: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Schedule = z.infer<typeof scheduleSchema>

export const schedulesResponseSchema = z.object({ items: z.array(scheduleSchema) })

// ScheduleInput — расписание, как его задаёт автор: всё, кроме того, что назначает
// сервер. Правится ЦЕЛИКОМ — экран сохраняет настройки одним куском, частичных
// патчей у расписания нет.
export type ScheduleInput = Omit<Schedule, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>

export const scheduleBlockSchema = z.object({
  id: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  note: z.string(),
})
export type ScheduleBlock = z.infer<typeof scheduleBlockSchema>

export const blocksResponseSchema = z.object({ items: z.array(scheduleBlockSchema) })

export const bookingSchema = z.object({
  id: z.string(),
  formId: z.string(),
  formTitle: z.string(),
  startsAt: z.string(),
  durationMinutes: z.number().int(),
  seats: z.number().int(),
  // submissionId пуст, если ответ удалили: бронь его переживает.
  submissionId: z.string().nullable(),
})
export type Booking = z.infer<typeof bookingSchema>

export const bookingsResponseSchema = z.object({ items: z.array(bookingSchema) })

// Умолчания нового расписания (утверждены владельцем 2026-09-03, DEV-PLAN фаза 27):
// расписание заводится готовым к работе, чтобы до первой записи ничего не
// настраивать. Буфер нулевой намеренно — он нужен не всем, а непонятая настройка
// сдвигает всю сетку.
export const DEFAULT_SCHEDULE: Omit<ScheduleInput, 'name'> = {
  timezone: 'Europe/Moscow',
  slotMinutes: 60,
  bufferMinutes: 0,
  horizonDays: 30,
  leadMinutes: 120,
  capacity: 1,
  maxSeatsPerBooking: 1,
  showRemaining: false,
  availability: {
    weekly: {
      mon: [{ from: '10:00', to: '18:00' }],
      tue: [{ from: '10:00', to: '18:00' }],
      wed: [{ from: '10:00', to: '18:00' }],
      thu: [{ from: '10:00', to: '18:00' }],
      fri: [{ from: '10:00', to: '18:00' }],
    },
    exceptions: [],
  },
}

// Часовые пояса России — тот выбор, который закрывает аудиторию продукта. Полный
// список IANA (около 400 зон) в выпадающем списке искать нечем, а сам он у нас не
// хранится: браузер отдаёт его через Intl, и лезть за ним ради одного поля дорого
// в интерфейсе, а не в байтах. Зона автора, если её здесь нет, добавляется к
// списку на лету (см. timezoneOptions).
export const RU_TIMEZONES: { value: string; title: string }[] = [
  { value: 'Europe/Kaliningrad', title: 'Калининград (UTC+2)' },
  { value: 'Europe/Moscow', title: 'Москва (UTC+3)' },
  { value: 'Europe/Samara', title: 'Самара (UTC+4)' },
  { value: 'Asia/Yekaterinburg', title: 'Екатеринбург (UTC+5)' },
  { value: 'Asia/Omsk', title: 'Омск (UTC+6)' },
  { value: 'Asia/Krasnoyarsk', title: 'Красноярск (UTC+7)' },
  { value: 'Asia/Irkutsk', title: 'Иркутск (UTC+8)' },
  { value: 'Asia/Yakutsk', title: 'Якутск (UTC+9)' },
  { value: 'Asia/Vladivostok', title: 'Владивосток (UTC+10)' },
  { value: 'Asia/Magadan', title: 'Магадан (UTC+11)' },
  { value: 'Asia/Kamchatka', title: 'Камчатка (UTC+12)' },
]

// timezoneOptions — список для выпадающего поля с гарантией, что ВЫБРАННАЯ зона в
// нём есть. Без этого расписание с зоной вне списка (заведено через API, приехало
// из другой страны) показывало бы пустое поле, а сохранение молча подменяло зону.
export function timezoneOptions(current: string): { value: string; title: string }[] {
  if (RU_TIMEZONES.some((z) => z.value === current)) return RU_TIMEZONES
  return [...RU_TIMEZONES, { value: current, title: current }]
}
