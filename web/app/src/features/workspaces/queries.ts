import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { workspaceKeys } from './keys'
import { createWorkspace, listWorkspaces } from './api'

// Пространства пользователя — серверный стейт, живёт только в Query. Меняются
// редко (создание — явное действие) → длинный staleTime.
export const workspacesQueryOptions = queryOptions({
  queryKey: workspaceKeys.list(),
  queryFn: listWorkspaces,
  staleTime: 5 * 60 * 1000,
})

// Создание пространства инвалидирует список: он же рисует сайдбар и
// переключатель, и забытая инвалидация означала бы «создал, но его нигде нет».
export function useCreateWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => createWorkspace(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.list() }),
  })
}
