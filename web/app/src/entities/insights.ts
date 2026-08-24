import { z } from 'zod'

// Карточки над вкладками аналитики (спека design/analytics-tally.md §5). Зеркалит
// insightsResponse из internal/visits/handler.go.
//
// Про ответы здесь ничего нет и быть не может: ответы и визиты — два независимых
// множества (docs/ANALYTICS.md §1), и число ответов приезжает своим запросом.
export const visitInsightsSchema = z.object({
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
})
export type VisitInsights = z.infer<typeof visitInsightsSchema>
