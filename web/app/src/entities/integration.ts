import { z } from 'zod'

// Интеграции формы (фаза 25). Зеркалит Go-DTO internal/integrations/handler.go —
// правка одной стороны требует правки другой.

// Состояние подключённого аккаунта в пространстве формы.
export const integrationAccountSchema = z.object({
  // enabled — настроен ли провайдер НА КОНТУРЕ (ключи в окружении бэка).
  // Отдельно от connected: «интеграции здесь нет вовсе» и «есть, но не
  // подключена» — разные экраны, и путать их значит советовать человеку нажать
  // кнопку, которой у него не появится.
  enabled: z.boolean(),
  connected: z.boolean(),
  email: z.string().optional(),
  connectedAt: z.string().optional(),
  // canManage — может ли СПРАШИВАЮЩИЙ подключать и отключать аккаунт. Кнопка
  // рисуется по нему, а не по роли: матрица прав живёт на бэке (web/CLAUDE.md).
  canManage: z.boolean(),
})

// Статус привязки формы к таблице.
export const sheetStatusSchema = z.enum(['backfilling', 'live', 'broken'])

export const formSheetSchema = z.object({
  url: z.string(),
  status: sheetStatusSchema,
  lastError: z.string().optional(),
  lastDeliveredAt: z.string().optional(),
})

export const formIntegrationsSchema = z.object({
  workspaceId: z.string(),
  account: integrationAccountSchema,
  // null — форма не привязана. Это состояние экрана, а не ошибка.
  sheet: formSheetSchema.nullable(),
})

export type IntegrationAccount = z.infer<typeof integrationAccountSchema>
export type FormSheet = z.infer<typeof formSheetSchema>
export type SheetStatus = z.infer<typeof sheetStatusSchema>
export type FormIntegrations = z.infer<typeof formIntegrationsSchema>
