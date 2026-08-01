import { z } from 'zod'

// Тариф воркспейса (фаза 17). Единственный источник типа — эта Zod-схема
// (web/CLAUDE.md); зеркалит DTO из internal/entitlements/handler.go.

// Возможность тарифа. kind различает два вида значения: quota — число (used/limit),
// toggle — да/нет. limit === null означает БЕЗЛИМИТ и это не то же, что 0: ноль
// запрещает всё.
export const planFeatureSchema = z.object({
  key: z.string(),
  title: z.string(),
  kind: z.enum(['quota', 'toggle']),
  allowed: z.boolean(),
  used: z.number().int(),
  limit: z.number().int().nullable(),
})

export type PlanFeature = z.infer<typeof planFeatureSchema>

// GET /workspaces/{id}/entitlements: план, его возможности и дата обнуления расхода.
export const planSnapshotSchema = z.object({
  planCode: z.string(),
  planTitle: z.string(),
  periodEnd: z.string(),
  features: z.array(planFeatureSchema),
})

export type PlanSnapshot = z.infer<typeof planSnapshotSchema>
