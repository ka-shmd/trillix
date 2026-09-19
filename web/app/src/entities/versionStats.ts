import { z } from 'zod'

// Разрез по версиям формы (спека design/analytics-v2.md §5.3). Зеркалит
// versionsResponse из internal/visits/handler.go.
export const versionStatSchema = z.object({
  number: z.number().int(),
  publishedAt: z.string(),
  visits: z.number().int(),
  submitted: z.number().int(),
  // Знаменатель медианы заполнения: 0 — данных нет, а не «ноль секунд».
  timedCompletions: z.number().int(),
  completionDurationSec: z.number(),
})

// Свежие версии сверху; версий без визитов в окне в списке нет.
export const versionStatsSchema = z.object({ versions: z.array(versionStatSchema) })

export type VersionStat = z.infer<typeof versionStatSchema>
