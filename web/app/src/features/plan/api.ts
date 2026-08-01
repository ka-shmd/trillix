import { apiRequest } from '../../shared/api/client'
import { planSnapshotSchema, type PlanSnapshot } from '../../entities/plan'

// Транспорт тарифа: снимок плана воркспейса, парсится Zod-схемой на границе.
export function getPlanSnapshot(workspaceId: string): Promise<PlanSnapshot> {
  return apiRequest(`/workspaces/${workspaceId}/entitlements`, { schema: planSnapshotSchema })
}
