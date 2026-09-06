import { apiRequest } from '../../shared/api/client'
import {
  accountPlanSchema,
  planSnapshotSchema,
  type AccountPlan,
  type PlanSnapshot,
} from '../../entities/plan'

// Транспорт тарифа: снимок плана воркспейса, парсится Zod-схемой на границе.
export function getPlanSnapshot(workspaceId: string): Promise<PlanSnapshot> {
  return apiRequest(`/workspaces/${workspaceId}/entitlements`, { schema: planSnapshotSchema })
}

// Снимок тарифа АККАУНТА — для страницы «Тариф». Id в адресе нет: субъект подписки
// это сам спрашивающий, и назвать чужой аккаунт нечем.
export function getAccountPlan(): Promise<AccountPlan> {
  return apiRequest('/account/entitlements', { schema: accountPlanSchema })
}
