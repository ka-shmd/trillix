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
  // pickerEnabled — настроено ли окно выбора файла на Диске (нужен отдельный
  // ключ). Отдельно от enabled: интеграция работает и без него — просто без
  // «выбрать существующую чужую таблицу».
  pickerEnabled: z.boolean().default(false),
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
  // name — подпись связки, которую человек дал в окне подключения. Пусто —
  // экран показывает имя провайдера.
  name: z.string().optional(),
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

// Таблица, куда можно положить ответы: под scope drive.file это ТОЛЬКО файлы,
// созданные нами, — чужих документов Диска в списке нет и быть не может.
export const spreadsheetRefSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const spreadsheetListSchema = z.object({
  spreadsheets: z.array(spreadsheetRefSchema),
})

export type SpreadsheetRef = z.infer<typeof spreadsheetRefSchema>
export type IntegrationAccount = z.infer<typeof integrationAccountSchema>
export type FormSheet = z.infer<typeof formSheetSchema>
export type SheetStatus = z.infer<typeof sheetStatusSchema>
export type FormIntegrations = z.infer<typeof formIntegrationsSchema>
