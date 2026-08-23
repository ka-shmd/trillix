import { z } from 'zod'

import { apiRequest } from '../../shared/api/client'
import {
  formIntegrationsSchema,
  formSheetSchema,
  sheetListSchema,
  spreadsheetListSchema,
  type FormIntegrations,
  type FormSheet,
  type SheetRef,
  type SpreadsheetRef,
} from '../../entities/integration'

// Транспорт интеграций. Ответы парсятся Zod-схемой на границе — непровалидированный
// any внутрь приложения не проходит (web/CLAUDE.md).

// Зеркалит pickerResponse в internal/integrations/handler.go.
const pickerCredentialsSchema = z.object({
  accessToken: z.string(),
  developerKey: z.string(),
  appId: z.string(),
})

export type PickerCredentials = z.infer<typeof pickerCredentialsSchema>

export function getFormIntegrations(formId: string): Promise<FormIntegrations> {
  return apiRequest(`/forms/${formId}/integrations`, { schema: formIntegrationsSchema })
}

// ConnectOptions — то, что человек назвал в окне подключения.
export interface ConnectOptions {
  name: string
  // Пусто — заводим новую книгу; иначе работаем в выбранной.
  spreadsheetId: string
  // Существующий лист книги; null — завести новый. Не 0: у первого листа книги
  // gid как раз ноль.
  sheetId: number | null
  backfill: boolean
}

export function createSheet(formId: string, opts: ConnectOptions): Promise<FormSheet> {
  return apiRequest(`/forms/${formId}/integrations/google`, {
    method: 'POST',
    body: {
      name: opts.name,
      spreadsheetId: opts.spreadsheetId,
      sheetId: opts.sheetId,
      backfill: opts.backfill,
    },
    schema: formSheetSchema,
  })
}

// Листы выбранной книги — второй шаг выбора.
export async function listSheets(formId: string, spreadsheetId: string): Promise<SheetRef[]> {
  const res = await apiRequest(
    `/forms/${formId}/integrations/google/sheets?spreadsheetId=${encodeURIComponent(spreadsheetId)}`,
    { schema: sheetListSchema },
  )
  return res.sheets
}

// Credentials окна выбора файла: живой токен Google на час. Запрашиваются по
// нажатию кнопки, а не при показе экрана, — токен не должен лежать в стейте
// страницы просто так.
export function getPickerCredentials(formId: string): Promise<PickerCredentials> {
  return apiRequest(`/forms/${formId}/integrations/google/picker`, { schema: pickerCredentialsSchema })
}

// Таблицы для выбора в окне. Запрашиваются при его открытии: список живёт у
// провайдера и устаревает, кэшировать его надолго нечестно.
export async function listSpreadsheets(formId: string): Promise<SpreadsheetRef[]> {
  const res = await apiRequest(`/forms/${formId}/integrations/google/spreadsheets`, {
    schema: spreadsheetListSchema,
  })
  return res.spreadsheets
}

// Операции над ОДНОЙ связкой адресуются её id: связок у формы сколько угодно.
export function refillSheet(formId: string, connectionId: string): Promise<void> {
  return apiRequest(`/forms/${formId}/integrations/${connectionId}/refill`, { method: 'POST' })
}

export function unlinkSheet(formId: string, connectionId: string): Promise<void> {
  return apiRequest(`/forms/${formId}/integrations/${connectionId}`, { method: 'DELETE' })
}

export function updateConnection(
  formId: string,
  connectionId: string,
  patch: { name: string; enabled: boolean },
): Promise<void> {
  return apiRequest(`/forms/${formId}/integrations/${connectionId}`, {
    method: 'PATCH',
    body: patch,
  })
}

export function disconnectAccount(workspaceId: string): Promise<void> {
  return apiRequest(`/workspaces/${workspaceId}/integrations/google`, { method: 'DELETE' })
}

// startUrl — адрес, с которого начинается поход за согласием Google. Это не
// вызов API, а НАВИГАЦИЯ: бэк отвечает редиректом и ставит cookie похода,
// поэтому адрес нужен ссылкой/окном, а не fetch'ем.
export function startUrl(workspaceId: string): string {
  return `/api/v1/workspaces/${workspaceId}/integrations/google/start`
}
