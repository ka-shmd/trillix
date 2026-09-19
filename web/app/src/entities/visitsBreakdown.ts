import { z } from 'zod'

// Вкладка «Визиты» (спека design/analytics-tally.md §8). Зеркалит
// breakdownResponse из internal/visits/handler.go.

// Шаг ряда выбирает СЕРВЕР (domain.StepFor и domain.CoarsenBuckets): от него
// зависят и запрос, и подписи оси, а вторая копия этого выбора на клиенте
// разъехалась бы молча.
//
// Недели и месяцы приезжают только укрупнением: запрос считает часы или сутки, а
// слишком длинный ряд сервер складывает уже по факту — «всё время» у новой формы
// это три дня, у старой три года.
export const bucketStepSchema = z.enum(['hour', 'day', 'week', 'month'])
export type BucketStep = z.infer<typeof bucketStepSchema>

export const timeBucketSchema = z.object({
  at: z.string(),
  visits: z.number().int(),
  submitted: z.number().int(),
})
export type TimeBucket = z.infer<typeof timeBucketSchema>

// submitted у строк разбивок — сколько визитов строки закончились ответом:
// конверсия строки (спека design/analytics-v2.md §5.2).
export const sourceCountSchema = z.object({
  source: z.string(),
  medium: z.string(),
  visits: z.number().int(),
  submitted: z.number().int(),
})
export type SourceCount = z.infer<typeof sourceCountSchema>

// Строка стран или городов. countryCode едет рядом с названием ради флага: у
// страны это её код, у города — код его страны (одноимённые города в разных
// странах — обычное дело).
export const placeCountSchema = z.object({
  name: z.string(),
  countryCode: z.string(),
  visits: z.number().int(),
  submitted: z.number().int(),
})
export type PlaceCount = z.infer<typeof placeCountSchema>

export const labelCountSchema = z.object({
  label: z.string(),
  visits: z.number().int(),
  submitted: z.number().int(),
})
export type LabelCount = z.infer<typeof labelCountSchema>

// sources пуст при sourcesLocked — разбивка закрыта тарифом. knownSources при этом
// настоящий: визиты собираются у всех планов, платным стал показ (docs/ANALYTICS.md
// §9), и плашка обязана показывать число владельца, а не рекламировать пустоту.
export const visitsBreakdownSchema = z.object({
  step: bucketStepSchema,
  timeseries: z.array(timeBucketSchema),
  sources: z.array(sourceCountSchema),
  sourcesLocked: z.boolean(),
  knownSources: z.number().int(),
  devices: z.array(labelCountSchema),
  browsers: z.array(labelCountSchema),
  systems: z.array(labelCountSchema),
  // Пустые списки означают «справочника гео на контуре нет» — блок не рисуется.
  // unknownPlace — визиты, которым место не определили (справочника нет, приватный
  // адрес, IPv6): граница метрики показывается рядом со списком, а не прячется.
  countries: z.array(placeCountSchema),
  cities: z.array(placeCountSchema),
  unknownPlace: z.number().int(),
  // geoConfigured отличает «справочника на контуре нет» (блок прячем) от «есть, но
  // мест не определили» (блок с объяснением). Пустые списки в обоих случаях
  // одинаковы, а означают разное — без этого флага выключенное гео неотличимо от
  // ненаписанной функции.
  geoConfigured: z.boolean(),
})
export type VisitsBreakdown = z.infer<typeof visitsBreakdownSchema>
