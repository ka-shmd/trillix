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
  confirmEmailChange,
  deleteAccount,
  disableTwoFactor,
  enableTwoFactor,
  isTwoFactorRequired,
  loginTwoFactor,
  setupTwoFactor,
  getIdentities,
  unlinkIdentity,
  requestEmailChange,
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

// Сессию открыл колбэк в отдельном окне: объекта пользователя у вкладки нет,
// есть только факт «вход состоялся». Вывод тот же, что у adoptSession (TD-40) —
// личность в этой вкладке сменилась, весь накопленный кэш чужой; сам me приедет
// гардом _app сразу после перехода.
export function adoptPopupSession(qc: QueryClient): void {
  qc.clear()
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: login,
    // Патчим кэш me возвращённым пользователем — забытая синхронизация это баг.
    // Но только если вход СОСТОЯЛСЯ: при требовании второго фактора сессии нет,
    // и класть в кэш нечего — иначе гард пустил бы в кабинет без входа.
    onSuccess: (result) => {
      if (!isTwoFactorRequired(result)) adoptSession(qc, result)
    },
  })
}

// Второй шаг входа: сессия открыта, личность в этой вкладке сменилась — тот же
// adoptSession, что у обычного входа (TD-40).
export function useLoginTwoFactor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: loginTwoFactor,
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
    //
    // Требование кода — не вход: сессии нет, класть в кэш нечего (та же
    // развилка, что у useLogin).
    onSuccess: (result) => {
      if (!isTwoFactorRequired(result)) adoptSession(qc, result)
    },
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

// Запрос смены адреса. Кэш не трогаем: адрес аккаунта не изменился — письмо
// только поставлено в очередь, и до перехода по ссылке в профиле всё прежнее.
export function useRequestEmailChange() {
  return useMutation({ mutationFn: requestEmailChange })
}

// Подтверждение нового адреса по ссылке из письма. Инвалидируем me: страницу
// могли открыть в той же вкладке, где открыт кабинет, и адрес в нём протух.
export function useConfirmEmailChange() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: confirmEmailChange,
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

// Способы входа — серверный стейт: список меняется привязкой (через переход к
// провайдеру и обратно) и отвязкой.
export const identitiesQueryOptions = queryOptions({
  queryKey: authKeys.identities(),
  queryFn: getIdentities,
  retry: false,
})

// Привязка, завершённая в отдельном окне: мутации, которая обновила бы кэш,
// здесь нет — привязку сделал колбэк в окне. Инвалидируем те же ключи, что и
// отвязка, иначе список способов входа останется вчерашним до перезагрузки.
export function useRefreshIdentities() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: authKeys.identities() })
    void qc.invalidateQueries({ queryKey: authKeys.me() })
  }
}

export function useUnlinkIdentity() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: unlinkIdentity,
    // Инвалидируем СПИСОК и профиль: отвязка не меняет hasPassword, но экран
    // рисует способы входа из обоих источников, и разъехаться им нельзя.
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: authKeys.identities() })
      await qc.invalidateQueries({ queryKey: authKeys.me() })
    },
  })
}

// Второй фактор в настройках. setup только показывает секрет (фактор ещё
// выключен), поэтому кэш профиля не трогает; enable и disable его меняют.
export function useSetupTwoFactor() {
  return useMutation({ mutationFn: setupTwoFactor })
}

export function useEnableTwoFactor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: enableTwoFactor,
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

export function useDisableTwoFactor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: disableTwoFactor,
    onSuccess: () => qc.invalidateQueries({ queryKey: authKeys.me() }),
  })
}

// Удаление аккаунта (слайс G). Кэш сносится ЦЕЛИКОМ, как при выходе: сессии
// больше нет, и оставленные в памяти формы прошлого аккаунта дождались бы
// следующего входа в этой вкладке (TD-40).
export function useDeleteAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deleteAccount,
    onSuccess: () => qc.clear(),
  })
}
