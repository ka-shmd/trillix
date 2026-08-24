import { z } from 'zod'
import { blockTypeSchema } from '@entities/formSchema'

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

export const blockSummarySchema = z.object({
  blockId: z.string(),
  label: z.string(),
  type: blockTypeSchema,
  kind: summaryKindSchema,
  asked: z.number().int(),
  answered: z.number().int(),
  buckets: z.array(summaryBucketSchema).default([]),
  number: numberStatsSchema.nullish(),
  // Последние значения — не больше десяти: остальное живёт в листинге ответов со
  // своей пагинацией. Сервер шлёт поле с omitempty, отсюда default.
  samples: z.array(answerSampleSchema).default([]),
})
export type BlockSummary = z.infer<typeof blockSummarySchema>

export const formSummarySchema = z.object({
  total: z.number().int(),
  blocks: z.array(blockSummarySchema),
})
export type FormSummary = z.infer<typeof formSummarySchema>
