import { apiRequest } from '../../shared/api/client'
import { formFunnelSchema, type FormFunnel } from '../../entities/funnel'

// Транспорт воронки: ответ парсится Zod-схемой на границе — непровалидированный any
// внутрь приложения не проходит (web/CLAUDE.md).
export function getFunnel(formId: string): Promise<FormFunnel> {
  return apiRequest(`/forms/${formId}/funnel`, { schema: formFunnelSchema })
}
