import { queryOptions } from '@tanstack/react-query'
import { workspaceKeys } from './keys'
import { listWorkspaces } from './api'

// Воркспейсы пользователя — серверный стейт, живёт только в Query. В MVP один
// личный воркспейс, меняется редко → длинный staleTime.
export const workspacesQueryOptions = queryOptions({
  queryKey: workspaceKeys.list(),
  queryFn: listWorkspaces,
  staleTime: 5 * 60 * 1000,
})
