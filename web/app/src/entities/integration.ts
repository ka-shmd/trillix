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
  // id связки: операции над ней адресуются им, а не формой — связок у формы
  // сколько угодно, в том числе в одну и ту же книгу.
  id: z.string(),
  url: z.string(),
  // spreadsheetId и sheetId — текущая цель. Экран правки открывается тем же
  // окном, что и подключение, и обязан показать в полях то, что уже выбрано.
  spreadsheetId: z.string(),
  sheetId: z.number().int(),
  // enabled — тумблер. Выключенная связка сохраняет таблицу, колонки и историю:
  // «выключить на время» и «удалить навсегда» — разные намерения.
  enabled: z.boolean(),
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
  // Пустой список — состояние экрана, а не ошибка: у формы просто нет связок.
  connections: z.array(formSheetSchema),
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

// Лист книги: gid и имя. gid — личность листа (имя автор волен переименовать),
// и у первого листа он равен нулю — поэтому «не выбрано» здесь не ноль, а
// отсутствие значения.
export const sheetRefSchema = z.object({
  id: z.number().int(),
  title: z.string(),
})

export const sheetListSchema = z.object({
  sheets: z.array(sheetRefSchema),
})

export type SpreadsheetRef = z.infer<typeof spreadsheetRefSchema>
export type SheetRef = z.infer<typeof sheetRefSchema>
export type IntegrationAccount = z.infer<typeof integrationAccountSchema>
export type FormSheet = z.infer<typeof formSheetSchema>
export type SheetStatus = z.infer<typeof sheetStatusSchema>
export type FormIntegrations = z.infer<typeof formIntegrationsSchema>
