import { apiRequest } from '../../shared/api/client'
import { workspaceSchema, workspacesResponseSchema, type Workspace } from '../../entities/workspace'
import {
  invitationSchema,
  membersResponseSchema,
  type Invitation,
  type MembersState,
} from '../../entities/member'

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

export function listMembers(workspaceId: string): Promise<MembersState> {
  return apiRequest(`/workspaces/${workspaceId}/members`, { schema: membersResponseSchema })
}

export function inviteMember(workspaceId: string, email: string): Promise<void> {
  // Роль пока одна: владельцем не приглашают (он ровно один), а третьей роли
  // в продукте нет. Появится — станет параметром.
  return apiRequest(`/workspaces/${workspaceId}/invitations`, {
    method: 'POST',
    body: { email, role: 'editor' },
  })
}

export function removeMember(workspaceId: string, userId: string): Promise<void> {
  return apiRequest(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' })
}

export function leaveWorkspace(workspaceId: string): Promise<void> {
  return apiRequest(`/workspaces/${workspaceId}/leave`, { method: 'POST' })
}

// Просмотр приглашения не требует сессии: аккаунта у позванного может ещё не быть.
export function previewInvitation(token: string): Promise<Invitation> {
  return apiRequest(`/invitations/${encodeURIComponent(token)}`, { schema: invitationSchema })
}

export function acceptInvitation(token: string): Promise<Workspace> {
  return apiRequest(`/invitations/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    schema: workspaceSchema,
  })
}
