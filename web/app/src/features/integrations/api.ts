import { z } from 'zod'

import { apiRequest } from '../../shared/api/client'
import {
  formIntegrationsSchema,
  formSheetSchema,
  spreadsheetListSchema,
  type FormIntegrations,
  type FormSheet,
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
  // Пусто — заводим новую книгу; иначе новый лист в уже созданной нами.
  spreadsheetId: string
  backfill: boolean
}

export function createSheet(formId: string, opts: ConnectOptions): Promise<FormSheet> {
  return apiRequest(`/forms/${formId}/integrations/google`, {
    method: 'POST',
    body: { name: opts.name, spreadsheetId: opts.spreadsheetId, backfill: opts.backfill },
    schema: formSheetSchema,
  })
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

export function refillSheet(formId: string): Promise<void> {
  return apiRequest(`/forms/${formId}/integrations/google/refill`, { method: 'POST' })
}

export function unlinkSheet(formId: string): Promise<void> {
  return apiRequest(`/forms/${formId}/integrations/google`, { method: 'DELETE' })
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
