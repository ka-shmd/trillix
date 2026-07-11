import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { formKeys } from './keys'
import { createForm, deleteForm, getForm, listForms, renameForm } from './api'

// Список форм — серверный стейт с курсорной пагинацией: страницы подгружаются
// через getNextPageParam, курсор непрозрачен для клиента.
export const formsListQueryOptions = infiniteQueryOptions({
  queryKey: formKeys.list(),
  queryFn: ({ pageParam }) => listForms(pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
})

export function formDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: formKeys.detail(id),
    queryFn: () => getForm(id),
  })
}

// Все мутации инвалидируют список (web/CLAUDE.md: забытая инвалидация — баг).

export function useCreateForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (title?: string) => createForm(title),
    onSuccess: () => qc.invalidateQueries({ queryKey: formKeys.list() }),
  })
}

export function useRenameForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameForm(id, title),
    onSuccess: (form) => {
      qc.invalidateQueries({ queryKey: formKeys.list() })
      qc.invalidateQueries({ queryKey: formKeys.detail(form.id) })
    },
  })
}

export function useDeleteForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteForm(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: formKeys.list() }),
  })
}
