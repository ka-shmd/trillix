import { z } from 'zod'

// Тариф (фаза 17; аккаунтный снимок — 2026-09-06). Единственный источник типа —
// эти Zod-схемы (web/CLAUDE.md); зеркалят DTO из internal/entitlements/handler.go.

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

// GET /account/entitlements: план АККАУНТА (платит человек, а не пространство —
// ADR §10). features — возможности плана и аккаунтные квоты (сообщения ассистенту,
// число пространств). Воркспейс-квот здесь нет: расход пространства — вопрос про
// пространство, и страница тарифа на него не отвечает.
export const accountPlanSchema = z.object({
  planCode: z.string(),
  planTitle: z.string(),
  periodEnd: z.string(),
  features: z.array(planFeatureSchema),
})

export type AccountPlan = z.infer<typeof accountPlanSchema>
