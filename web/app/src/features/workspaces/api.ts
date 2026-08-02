import { apiRequest } from '../../shared/api/client'
import { workspaceSchema, workspacesResponseSchema, type Workspace } from '../../entities/workspace'

// Транспорт workspaces: каждый ответ парсится Zod-схемой на границе.

export async function listWorkspaces(): Promise<Workspace[]> {
  const res = await apiRequest('/workspaces', { schema: workspacesResponseSchema })
  return res.workspaces
}

// createWorkspace заводит КОМАНДНОЕ пространство: создатель становится его
// владельцем. 402 (лимит тарифа) прилетает как ошибка апи и разбирается вызовом.
export function createWorkspace(name: string): Promise<Workspace> {
  return apiRequest('/workspaces', {
    method: 'POST',
    body: { name },
    schema: workspaceSchema,
  })
}
