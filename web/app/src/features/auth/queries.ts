import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { authKeys, oauthKeys } from './keys'
import { getMe, getProviders, linkProvider, login, logout, register } from './api'
import type { User } from '../../entities/user'

// Профиль текущего пользователя — серверный стейт, живёт только в Query.
// retry:false — 401 не ретраится, это ответ «не залогинен», а не сбой.
export const meQueryOptions = queryOptions({
  queryKey: authKeys.me(),
  queryFn: getMe,
  retry: false,
  staleTime: 5 * 60 * 1000,
})

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: login,
    // Патчим кэш me возвращённым пользователем — забытая синхронизация это баг.
    onSuccess: (user: User) => qc.setQueryData(authKeys.me(), user),
  })
}

export function useRegister() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: register,
    onSuccess: (user: User) => qc.setQueryData(authKeys.me(), user),
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: logout,
    // Сессия мертва — убираем me из кэша, чтобы гард не пустил в приложение.
    onSuccess: () => qc.removeQueries({ queryKey: authKeys.me() }),
  })
}

// Включённые провайдеры — серверный стейт: список задаётся окружением бэка и
// между перезагрузками не меняется, поэтому длинный staleTime.
export const providersQueryOptions = queryOptions({
  queryKey: oauthKeys.providers(),
  queryFn: getProviders,
  retry: false,
  staleTime: 30 * 60 * 1000,
})

export function useLinkProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: linkProvider,
    // После привязки открыта полноценная сессия — кэш me патчим, как в логине.
    onSuccess: (user: User) => qc.setQueryData(authKeys.me(), user),
  })
}
