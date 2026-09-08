import { apiRequest } from '../../shared/api/client'
import { workspaceSchema, workspacesResponseSchema, type Workspace } from '../../entities/workspace'
import {
  joinLinkResponseSchema,
  joinPreviewSchema,
  membersResponseSchema,
  type JoinLink,
  type JoinPreview,
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

// renameWorkspace правит вывеску пространства. Право спрашивает сервер
// (workspace.manage); кабинет прячет пункт меню по permissions, но решает не он.
export function renameWorkspace(workspaceId: string, name: string): Promise<Workspace> {
  return apiRequest(`/workspaces/${workspaceId}`, {
    method: 'PATCH',
    body: { name },
    schema: workspaceSchema,
  })
}

// deleteWorkspace сносит пространство со всем содержимым: формы, ответы и файлы
// уходят вместе с ним и не восстанавливаются. Личное сервер удалить не даст (422).
export function deleteWorkspace(workspaceId: string): Promise<void> {
  return apiRequest(`/workspaces/${workspaceId}`, { method: 'DELETE' })
}

export function listMembers(workspaceId: string): Promise<MembersState> {
  return apiRequest(`/workspaces/${workspaceId}/members`, { schema: membersResponseSchema })
}

// Ссылка-приглашение — единственный способ позвать человека (ADR §10).
//
// Чтение отдаёт `null`, когда живой ссылки нет: это состояние пространства, а не
// отказ, и отличать его от «пространства нет» кабинету необходимо.
export async function getJoinLink(workspaceId: string): Promise<JoinLink | null> {
  const res = await apiRequest(`/workspaces/${workspaceId}/join-link`, {
    schema: joinLinkResponseSchema,
  })
  return res.link
}

// createJoinLink ВСЕГДА выписывает новую, гася прежнюю: команда человека здесь —
// «дай ссылку, которую я разошлю», и отдавать вчерашнюю значило бы продлевать
// срок мимо решения о сутках.
export async function createJoinLink(workspaceId: string): Promise<JoinLink> {
  const res = await apiRequest(`/workspaces/${workspaceId}/join-link`, {
    method: 'POST',
    schema: joinLinkResponseSchema,
  })
  if (res.link === null) throw new Error('сервер не вернул ссылку')
  return res.link
}

export function revokeJoinLink(workspaceId: string): Promise<void> {
  return apiRequest(`/workspaces/${workspaceId}/join-link`, { method: 'DELETE' })
}

export function removeMember(workspaceId: string, userId: string): Promise<void> {
  return apiRequest(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' })
}

// transferOwnership отдаёт пространство другому его участнику: отдающий
// становится редактором, получатель — владельцем и плательщиком. Своя ручка, а не
// PATCH участника с новой ролью: ролей две, и «смена роли» сегодня означает ровно
// одно — смену плательщика.
export function transferOwnership(workspaceId: string, userId: string): Promise<void> {
  return apiRequest(`/workspaces/${workspaceId}/ownership`, {
    method: 'POST',
    body: { userId },
  })
}

export function leaveWorkspace(workspaceId: string): Promise<void> {
  return apiRequest(`/workspaces/${workspaceId}/leave`, { method: 'POST' })
}

// Просмотр ссылки не требует сессии: аккаунта у зовомого может ещё не быть.
export function previewJoinLink(token: string): Promise<JoinPreview> {
  return apiRequest(`/join/${encodeURIComponent(token)}`, { schema: joinPreviewSchema })
}

export function acceptJoinLink(token: string): Promise<Workspace> {
  return apiRequest(`/join/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    schema: workspaceSchema,
  })
}
