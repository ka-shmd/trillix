import { type QueryClient, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { authKeys, oauthKeys } from './keys'
import {
  forgotPassword,
  getMe,
  getProviders,
  linkProvider,
  login,
  logout,
  register,
  changePassword,
  resendVerification,
  resetPassword,
  updateProfile,
  verifyEmail,
} from './api'
import type { User } from '../../entities/user'

// Профиль текущего пользователя — серверный стейт, живёт только в Query.
// retry:false — 401 не ретраится, это ответ «не залогинен», а не сбой.
export const meQueryOptions = queryOptions({
  queryKey: authKeys.me(),
  queryFn: getMe,
  retry: false,
  staleTime: 5 * 60 * 1000,
})

// adoptSession — единая реакция на «в этой вкладке теперь другая личность»: снести
// ВЕСЬ клиентский кэш и положить в него нового пользователя.
//
// Выборочное удаление одного лишь authKeys.me() (как было до TD-40) оставляло в
// общем in-memory QueryClient формы, детали, ответы и воронки предыдущего аккаунта,
// и SPA отдавала их следующему прямо из кэша, без обращения к серверу. Серверная
// идентичность при этом всегда была верной — она определяется исключительно cookie
// session, — поэтому лечится это только на клиенте.
//
// Порядок важен: clear() первым, setQueryData — после, иначе свежий me вычистился бы
// вместе с чужими данными, и гард _app сходил бы за ним ещё раз впустую.
function adoptSession(qc: QueryClient, user: User): void {
  qc.clear()
  qc.setQueryData(authKeys.me(), user)
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: login,
    // Патчим кэш me возвращённым пользователем — забытая синхронизация это баг.
    onSuccess: (user: User) => adoptSession(qc, user),
  })
}

export function useRegister() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: register,
    onSuccess: (user: User) => adoptSession(qc, user),
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: logout,
    // Сессия мертва — сносим ВЕСЬ кэш, а не только me: иначе формы и ответы
    // вышедшего аккаунта дождутся следующего входа в этой вкладке (TD-40).
    onSuccess: () => qc.clear(),
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

// Сброс пароля — стейта в кэше не трогает: пользователь не залогинен, а reset
// на бэке рвёт все сессии. Экраны сами показывают исход по состоянию мутации.
export function useForgotPassword() {
  return useMutation({ mutationFn: forgotPassword })
}

export function useResetPassword() {
  return useMutation({ mutationFn: resetPassword })
}

// Подтверждение email по токену из письма. После успеха инвалидируем me: если
// пользователь залогинен, баннер «подтвердите почту» должен пропасть сразу.
export function useVerifyEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: verifyEmail,
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

// Повторная отправка письма подтверждения (кнопка в баннере). Кэш не трогает —
// подтверждение придёт переходом по ссылке из письма, не этим запросом.
export function useResendVerification() {
  return useMutation({ mutationFn: resendVerification })
}

export function useLinkProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: linkProvider,
    // После привязки открыта полноценная сессия — это такой же вход, как login, и
    // сбрасывать кэш надо по той же причине (TD-40). Путь не гипотетический:
    // сессия предыдущего аккаунта могла истечь без logout, и его данные лежат в
    // кэше этой вкладки, пока сюда приходит другая личность.
    onSuccess: (user: User) => adoptSession(qc, user),
  })
}

// Правка профиля. Ответ — весь объект пользователя, поэтому кэш ПАТЧИТСЯ им, а
// не инвалидируется: инвалидация дала бы лишний GET /auth/me и мигание имени в
// сайдбаре между ответом и рефетчем.
export function useUpdateProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: updateProfile,
    onSuccess: (user: User) => qc.setQueryData(authKeys.me(), user),
  })
}

// Смена пароля. Кэш профиля не трогаем: в объекте пользователя меняется только
// hasPassword, и то лишь у аккаунта, который пароль ЗАДАЁТ, — поэтому me
// инвалидируется, а не патчится (тела у ответа нет).
export function useChangePassword() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: changePassword,
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}
