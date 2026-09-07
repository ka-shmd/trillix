import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { workspaceKeys } from './keys'
import {
  acceptInvitation,
  createWorkspace,
  deleteWorkspace,
  inviteMember,
  leaveWorkspace,
  listMembers,
  listWorkspaces,
  previewInvitation,
  removeMember,
  renameWorkspace,
} from './api'

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

// Переименование инвалидирует список: он же рисует обзор, сайдбар и крошки
// редактора — и оставшееся старое имя читалось бы как «правка не сохранилась».
// Патчить кэш ответом нельзя: в нём formCount = 0 (мутация отвечает вывеской,
// а не сводкой), и число форм в обзоре обнулилось бы на ровном месте.
export function useRenameWorkspace(workspaceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => renameWorkspace(workspaceId, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.list() }),
  })
}

// Удаление пространства инвалидирует список пространств. Списки форм чистит
// ВЫЗЫВАЮЩИЙ: формы удалённого ушли вместе с ним, но ключи форм принадлежат
// чужой фиче, а импорт фичи из фичи запрещён (web/CLAUDE.md).
export function useDeleteWorkspace(workspaceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => deleteWorkspace(workspaceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.list() }),
  })
}

export function membersQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: workspaceKeys.members(workspaceId),
    queryFn: () => listMembers(workspaceId),
    // Состав меняется редко и только явными действиями, которые сами
    // инвалидируют этот ключ (приглашение, снятие доступа). Длинный staleTime
    // нужен обзору пространств: он тянет состав на КАЖДУЮ строку (N+1, §6
    // WORKSPACES.md), и без оговорки возврат на обзор стоил бы этих запросов
    // заново.
    staleTime: 5 * 60 * 1000,
  })
}

export function invitationQueryOptions(token: string) {
  return queryOptions({
    queryKey: workspaceKeys.invitation(token),
    queryFn: () => previewInvitation(token),
    // Приглашение живёт по ссылке из письма: перечитывать его при возврате на
    // вкладку незачем, а вот протухнуть между открытием и принятием оно может —
    // это разбирает сама мутация принятия (410).
    staleTime: 60 * 1000,
    retry: false,
  })
}

// Все мутации состава инвалидируют состав ЭТОГО пространства: забытая
// инвалидация здесь означала бы «снял доступ, а человек ещё в списке».
export function useInviteMember(workspaceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (email: string) => inviteMember(workspaceId, email),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.members(workspaceId) }),
  })
}

export function useRemoveMember(workspaceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => removeMember(workspaceId, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.members(workspaceId) }),
  })
}

// Выход меняет ЛИЧНЫЙ список пространств, а не только состав: после него
// пространство исчезает из сайдбара.
export function useLeaveWorkspace(workspaceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => leaveWorkspace(workspaceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.list() }),
  })
}

export function useAcceptInvitation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (token: string) => acceptInvitation(token),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.list() }),
  })
}
