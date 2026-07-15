import { apiRequest } from '../../shared/api/client'
import { workspacesResponseSchema, type Workspace } from '../../entities/workspace'

// Транспорт workspaces: список воркспейсов пользователя, парсится на границе.
export async function listWorkspaces(): Promise<Workspace[]> {
  const res = await apiRequest('/workspaces', { schema: workspacesResponseSchema })
  return res.workspaces
}
