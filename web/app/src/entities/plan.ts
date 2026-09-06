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

// Пространство в аккаунтном снимке: его собственные квоты (ответы, участники,
// файлы, расписания). Плана в строке нет — он у всех пространств аккаунта один.
export const planWorkspaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  isPersonal: z.boolean(),
  features: z.array(planFeatureSchema),
})

export type PlanWorkspace = z.infer<typeof planWorkspaceSchema>

// GET /account/entitlements: план АККАУНТА (платит человек, а не пространство —
// ADR §10). features — возможности плана и аккаунтные квоты (сообщения ассистенту,
// число пространств); воркспейс-квоты приезжают строкой на пространство.
export const accountPlanSchema = z.object({
  planCode: z.string(),
  planTitle: z.string(),
  periodEnd: z.string(),
  features: z.array(planFeatureSchema),
  workspaces: z.array(planWorkspaceSchema),
})

export type AccountPlan = z.infer<typeof accountPlanSchema>
