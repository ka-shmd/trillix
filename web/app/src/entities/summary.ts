import { z } from 'zod'
import { blockTypeSchema } from '@entities/formSchema'
import { bucketStepSchema } from './visitsBreakdown'

// Сводка ответов формы (фаза 8.5 шаг 3). Единственный источник типа — эта Zod-схема
// (web/CLAUDE.md), зеркалит summaryResponse из internal/submissions/handler.go.
// Считает сервер: сюда приходят только счётчики, сырые ответы в браузер не едут.

// kind — по нему выбирается вид: распределение баров, статистика чисел или доля
// заполнивших. Зеркалит SummaryKind в internal/domain/summary.go.
export const summaryKindSchema = z.enum(['distribution', 'number', 'fill'])
export type SummaryKind = z.infer<typeof summaryKindSchema>

// Деление распределения: key — внутреннее значение (id варианта, число шкалы),
// label — то, что видит владелец.
export const summaryBucketSchema = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
})
export type SummaryBucket = z.infer<typeof summaryBucketSchema>

export const numberStatsSchema = z.object({
  avg: z.number(),
  min: z.number(),
  max: z.number(),
})

// buckets/number приходят только там, где осмысленны (сервер шлёт их с omitempty) —
// отсюда default/nullish, а не обязательные поля. Ветвление на экране — по kind.
//
// asked — сколько человек этот вопрос ВИДЕЛИ (ответы по версиям, где он был), а не
// сколько ответов у формы всего: вопрос, добавленный в v2, иначе выглядел бы
// пропущенным у всех, кто отвечал по v1. Знаменатель доли — он.
// Одно показанное значение ответа: текст уже готов к показу (подписи опций вместо
// внутренних id), время — для «2 минуты назад».
export const answerSampleSchema = z.object({
  text: z.string(),
  at: z.string(),
})
export type AnswerSample = z.infer<typeof answerSampleSchema>

// Шкала и звёзды (спека design/analytics-v2.md §6.1): средняя, NPS у шкалы 0–10 и
// ряд средней по корзинам окна. n = 0 — в корзине ответов не было, avg тогда ничего
// не значит: «средняя 0» и «никто не ответил» — разные показания.
export const scalePointSchema = z.object({
  at: z.string(),
  n: z.number().int(),
  avg: z.number(),
})
export type ScalePoint = z.infer<typeof scalePointSchema>

export const scaleStatsSchema = z.object({
  avg: z.number(),
  // Нет у шкалы не 0–10: у шкалы 1–5 «промоутеров» не бывает.
  nps: z.number().int().optional(),
  trend: z.array(scalePointSchema),
})
export type ScaleStats = z.infer<typeof scaleStatsSchema>

export const blockSummarySchema = z.object({
  blockId: z.string(),
  label: z.string(),
  type: blockTypeSchema,
  kind: summaryKindSchema,
  asked: z.number().int(),
  answered: z.number().int(),
  buckets: z.array(summaryBucketSchema).default([]),
  number: numberStatsSchema.nullish(),
  // Только у шкал и звёзд, на которые ответили (сервер шлёт с omitempty).
  scale: scaleStatsSchema.nullish(),
  // Последние значения — не больше десяти: остальное живёт в листинге ответов со
  // своей пагинацией. Сервер шлёт поле с omitempty, отсюда default.
  samples: z.array(answerSampleSchema).default([]),
})
export type BlockSummary = z.infer<typeof blockSummarySchema>

export const formSummarySchema = z.object({
  total: z.number().int(),
  blocks: z.array(blockSummarySchema),
  // Шаг рядов шкал — выбирает сервер по окну, как у ряда визитов.
  trendStep: bucketStepSchema,
  // Сколько ответов в окне без фильтра («в выборке N из M»); только при фильтре.
  unfiltered: z.number().int().optional(),
  // Сегмент по визиту, в котором меньше 5 ответов: вопросов и чисел нет (ADR §10).
  withheld: z.boolean().default(false),
})
export type FormSummary = z.infer<typeof formSummarySchema>

// Страница значений ОДНОГО вопроса — окно «все ответы» на вкладке «Сводка».
// Зеркалит blockAnswersResponse из internal/submissions/handler.go.
//
// Значение приходит готовым ТЕКСТОМ, тем же, что в samples сводки: подпись опции, а
// не её id. Разбирать ответ здесь значило бы завести третью копию доменных правил
// после Go и Zod схемы формы.
export const blockAnswersPageSchema = z.object({
  answers: z.array(answerSampleSchema),
  // null — ответы формы кончились. Не «страница неполная»: вопрос за условием даёт
  // пустые страницы посреди формы.
  nextCursor: z.string().nullable(),
  withheld: z.boolean().default(false),
})
export type BlockAnswersPage = z.infer<typeof blockAnswersPageSchema>

// Таблица сопряжённости двух закрытых вопросов (спека design/analytics-v2.md §6.3).
// Зеркалит crosstabResponse из internal/submissions/handler.go. total у строки и
// столбца — ответов с этим значением в таблице; у множественного выбора сумма клеток
// строки бывает больше её итога.
const crossAxisSchema = z.object({ key: z.string(), label: z.string(), total: z.number().int() })
export const crosstabSchema = z.object({
  rows: z.array(crossAxisSchema),
  cols: z.array(crossAxisSchema),
  cells: z.array(z.array(z.number().int())),
  total: z.number().int(),
  withheld: z.boolean().default(false),
})
export type Crosstab = z.infer<typeof crosstabSchema>
