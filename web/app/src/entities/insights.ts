import { z } from 'zod'

// Карточки над вкладками аналитики (спека design/analytics-tally.md §5). Зеркалит
// insightsResponse из internal/visits/handler.go.
//
// Про ответы здесь ничего нет и быть не может: ответы и визиты — два независимых
// множества (docs/ANALYTICS.md §1), и число ответов приезжает своим запросом.
const insightsCountersSchema = z.object({
  visits: z.number().int(),
  submitted: z.number().int(),
  // uniqueVisitors — сколько РАЗНЫХ посетителей. Ключ посетителя суточный, поэтому
  // за период длиннее суток число завышено: один человек, заходивший три дня
  // подряд, выглядит тремя. Оговорка обязана стоять на экране рядом с числом.
  uniqueVisitors: z.number().int(),
  // timedVisits — знаменатель медианы: сколько визитов в неё вошло. Ноль означает
  // «данных нет», и экран обязан отличать это от «визиты длиной ноль секунд».
  timedVisits: z.number().int(),
  medianDurationSec: z.number(),
  // Длительность ЗАВЕРШЕНИЯ формы и её знаменатель — карточки вкладки «Отвалы».
  timedCompletions: z.number().int(),
  completionDurationSec: z.number(),
  // Начали отвечать: тронули вопрос или отправили.
  started: z.number().int(),
})

// previous — те же числа за прошлое окно той же длины (фаза 30, сравнение на
// карточках); нет у «всего времени».
export const visitInsightsSchema = insightsCountersSchema.extend({
  previous: insightsCountersSchema.optional(),
})
export type VisitInsights = z.infer<typeof visitInsightsSchema>
export type InsightsCounters = z.infer<typeof insightsCountersSchema>
