import { apiRequest } from '../../shared/api/client'
import { formIntegrationsSchema, formSheetSchema, type FormIntegrations, type FormSheet } from '../../entities/integration'

// Транспорт интеграций. Ответы парсятся Zod-схемой на границе — непровалидированный
// any внутрь приложения не проходит (web/CLAUDE.md).

export function getFormIntegrations(formId: string): Promise<FormIntegrations> {
  return apiRequest(`/forms/${formId}/integrations`, { schema: formIntegrationsSchema })
}

export function createSheet(formId: string): Promise<FormSheet> {
  return apiRequest(`/forms/${formId}/integrations/google`, {
    method: 'POST',
    schema: formSheetSchema,
  })
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
