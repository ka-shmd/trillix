import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'

import {
  identitiesQueryOptions,
  meQueryOptions,
  providersQueryOptions,
  useChangePassword,
  useRequestEmailChange,
  useUnlinkIdentity,
  useUpdateProfile,
} from '../../features/auth/queries'
import { identityLinkUrl } from '../../features/auth/api'
import { providerTitle } from '../../entities/identity'
import { formatDate } from '../../shared/format'
import { ApiError } from '../../shared/api/errors'
import type { User } from '../../entities/user'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Страница «Аккаунт» (/settings/account). Фаза 23 DEV-PLAN: профиль, адрес,
// пароль и способы входа. Дальше сюда приезжают второй фактор и удаление
// аккаунта (docs/design/account-settings.md).
//
// link — исход возврата от провайдера после привязки (слайс E). Колбэк это
// навигация браузера, а не вызов API: сказать «получилось» он может только
// параметром адреса. Мусор гасит catch — правка адреса руками не должна ронять
// экран.
const accountSearchSchema = z.object({
  link: z.enum(['ok', 'conflict', 'expired', 'failed']).optional().catch(undefined),
})

export const Route = createFileRoute('/_app/settings/account')({
  validateSearch: accountSearchSchema,
  component: AccountPage,
})

// MAX_NAME_LEN зеркалит MaxPersonNameLen из internal/auth/service_account.go.
// Расхождение с сервером даст 422 на форме, которая считает себя валидной.
const MAX_NAME_LEN = 100

function AccountPage() {
  // Профиль уже в кэше — его положил гард _app; отдельного состояния загрузки
  // здесь быть не может.
  const { data: user } = useQuery(meQueryOptions)
  if (!user) return null
  // key по id: смена личности в той же вкладке (вход другим аккаунтом) обязана
  // сбрасывать черновик формы, иначе она покажет имя предыдущего пользователя.
  // Ремаунтом, а не эффектом-синхронизатором: setState в теле эффекта запрещён
  // линтом (react-hooks/set-state-in-effect) и даёт каскадный ререндер.
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 p-6">
      <AccountForm key={user.id} user={user} />
      <EmailForm key={`email-${user.email}`} user={user} />
      <PasswordForm key={`pwd-${user.id}`} hasPassword={user.hasPassword} />
      <IdentitiesSection hasPassword={user.hasPassword} />
    </div>
  )
}

function AccountForm({ user }: { user: User }) {
  const update = useUpdateProfile()
  const [firstName, setFirstName] = useState(user.firstName)
  const [lastName, setLastName] = useState(user.lastName)

  const tooLong = firstName.length > MAX_NAME_LEN || lastName.length > MAX_NAME_LEN
  const dirty = firstName !== user.firstName || lastName !== user.lastName

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (tooLong) return
    update.mutate({ firstName, lastName })
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="text-lg font-medium">Аккаунт</h1>
        <p className="mt-1 text-sm text-muted-foreground">Как вас зовут в кабинете.</p>
      </section>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="first-name" className="mb-2 block">
              Имя
            </Label>
            <Input
              id="first-name"
              value={firstName}
              maxLength={MAX_NAME_LEN}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="Иван"
            />
          </div>
          <div>
            <Label htmlFor="last-name" className="mb-2 block">
              Фамилия
            </Label>
            <Input
              id="last-name"
              value={lastName}
              maxLength={MAX_NAME_LEN}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Петров"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!dirty || tooLong || update.isPending}>
            {update.isPending ? 'Сохраняем…' : 'Сохранить'}
          </Button>
          {update.isSuccess && !dirty && (
            <span className="text-sm text-muted-foreground">Сохранено</span>
          )}
        </div>

        {update.isError && (
          <p role="alert" className="text-sm text-destructive">
            Не удалось сохранить. Попробуйте ещё раз.
          </p>
        )}
      </form>
    </div>
  )
}

// MIN_PASSWORD_LEN зеркалит minPasswordLen из internal/auth/service.go.
const MIN_PASSWORD_LEN = 8

// PasswordForm — «Сменить пароль», а у аккаунта через провайдера «Задать
// пароль»: пароля у него нет, текущий спрашивать не с чего, и доказательством
// служит живая сессия.
function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const change = useChangePassword()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LEN
  const ready = next.length >= MIN_PASSWORD_LEN && (!hasPassword || current !== '')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready) return
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        // Поля чистятся только на успехе: при неверном текущем пароле человек
        // должен видеть, что именно он вводил, а не пустую форму.
        onSuccess: () => {
          setCurrent('')
          setNext('')
        },
      },
    )
  }

  return (
    <section className="flex flex-col gap-4 border-t pt-8">
      <div>
        <h2 className="text-lg font-medium">{hasPassword ? 'Пароль' : 'Пароль не задан'}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {hasPassword
            ? 'После смены все остальные устройства выйдут из аккаунта, а на почту придёт уведомление.'
            : 'Вы входите через провайдера. Пароль позволит войти и без него.'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {hasPassword && (
          <div>
            <Label htmlFor="current-password" className="mb-2 block">
              Текущий пароль
            </Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
        )}
        <div>
          <Label htmlFor="new-password" className="mb-2 block">
            {hasPassword ? 'Новый пароль' : 'Пароль'}
          </Label>
          <Input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          {tooShort && (
            <p className="mt-2 text-sm text-muted-foreground">
              Не короче {MIN_PASSWORD_LEN} символов.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!ready || change.isPending}>
            {change.isPending ? 'Сохраняем…' : hasPassword ? 'Сменить пароль' : 'Задать пароль'}
          </Button>
          {change.isSuccess && next === '' && (
            <span className="text-sm text-muted-foreground">Пароль изменён</span>
          )}
        </div>

        {change.isError && (
          <p role="alert" className="text-sm text-destructive">
            {passwordErrorText(change.error)}
          </p>
        )}
      </form>
    </section>
  )
}

// Ветвимся по code, а не по тексту ошибки: у каждого отказа свой совет, и
// «что-то пошло не так» здесь бесполезно — человек не поймёт, что чинить.
function passwordErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Текущий пароль неверный.'
      case 'validation_failed':
        return `Пароль должен быть не короче ${MIN_PASSWORD_LEN} символов.`
      case 'rate_limited':
        return 'Слишком много попыток. Подождите минуту и попробуйте снова.'
    }
  }
  return 'Не удалось сменить пароль. Попробуйте ещё раз.'
}

// EmailForm — смена адреса. Двухшаговая: эта форма только отправляет письмо,
// адрес аккаунта меняется по ссылке из него. Поэтому успех здесь — «письмо
// отправлено», а не «адрес изменён», и врать об этом нельзя.
function EmailForm({ user }: { user: User }) {
  const request = useRequestEmailChange()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const ready = email.trim() !== '' && (!user.hasPassword || password !== '')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready) return
    request.mutate(
      { newEmail: email.trim(), currentPassword: password },
      { onSuccess: () => setPassword('') },
    )
  }

  if (request.isSuccess) {
    return (
      <section className="flex flex-col gap-2 border-t pt-8">
        <h2 className="text-lg font-medium">Письмо отправлено</h2>
        <p className="text-sm text-muted-foreground">
          Мы написали на {email.trim()}. Аккаунт переедет на этот адрес, когда вы перейдёте по
          ссылке из письма; до тех пор вход остаётся по {user.email}.
        </p>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-4 border-t pt-8">
      <div>
        <h2 className="text-lg font-medium">Адрес аккаунта</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Сейчас {user.email}
          {user.emailVerified ? ' — подтверждён.' : ' — не подтверждён.'} На него приходят
          письма и восстановление доступа.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <Label htmlFor="new-email" className="mb-2 block">
            Новый адрес
          </Label>
          <Input
            id="new-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ivan@example.com"
          />
        </div>
        {user.hasPassword && (
          <div>
            <Label htmlFor="email-password" className="mb-2 block">
              Текущий пароль
            </Label>
            <Input
              id="email-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}

        <div>
          <Button type="submit" disabled={!ready || request.isPending}>
            {request.isPending ? 'Отправляем…' : 'Отправить письмо'}
          </Button>
        </div>

        {request.isError && (
          <p role="alert" className="text-sm text-destructive">
            {emailErrorText(request.error)}
          </p>
        )}
      </form>
    </section>
  )
}

function emailErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Текущий пароль неверный.'
      case 'email_taken':
        return 'Этот адрес уже занят другим аккаунтом.'
      case 'validation_failed':
        return 'Проверьте адрес: похоже, в нём опечатка.'
      case 'rate_limited':
        return 'Слишком много запросов. Попробуйте позже.'
    }
  }
  return 'Не удалось отправить письмо. Попробуйте ещё раз.'
}

// IdentitiesSection — способы входа через провайдеров (слайс E). VK ID появится
// здесь новой карточкой без правок: список строится из того, что подключено, и
// того, что вообще включено в окружении бэка.
function IdentitiesSection({ hasPassword }: { hasPassword: boolean }) {
  const { link } = Route.useSearch()
  const identities = useQuery(identitiesQueryOptions)
  const providers = useQuery(providersQueryOptions)
  const unlink = useUnlinkIdentity()

  const connected = identities.data ?? []
  const available = (providers.data ?? []).filter(
    (p) => !connected.some((c) => c.provider === p),
  )
  // Последний способ войти снять нельзя — кнопку не рисуем и говорим почему.
  // Сервер ответит 409 в любом случае, но узнавать об этом из ошибки после
  // нажатия — плохой способ объяснять правило.
  const lastWayIn = !hasPassword && connected.length <= 1

  return (
    <section className="flex flex-col gap-4 border-t pt-8">
      <div>
        <h2 className="text-lg font-medium">Способы входа</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Аккаунт один, войти в него можно несколькими способами.
        </p>
      </div>

      {link && (
        <p
          role="status"
          className={link === 'ok' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}
        >
          {linkOutcomeText(link)}
        </p>
      )}

      {identities.isError ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="mb-3 text-sm">Не удалось загрузить способы входа.</p>
          <Button variant="outline" size="sm" onClick={() => identities.refetch()}>
            Повторить
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          <li className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm">Пароль</p>
              <p className="text-sm text-muted-foreground">
                {hasPassword ? 'Задан' : 'Не задан'}
              </p>
            </div>
          </li>
          {connected.map((identity) => (
            <li
              key={identity.provider}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{providerTitle(identity.provider)}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {identity.providerEmail !== '' && `${identity.providerEmail} · `}
                  подключён {formatDate(identity.connectedAt)}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={lastWayIn || unlink.isPending}
                onClick={() => unlink.mutate(identity.provider)}
              >
                Отключить
              </Button>
            </li>
          ))}
        </ul>
      )}

      {lastWayIn && connected.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Это единственный способ войти. Чтобы его отключить, сначала задайте пароль.
        </p>
      )}

      {available.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {available.map((provider) => (
            // Ссылка, а не кнопка с fetch: браузеру нужен полноценный переход к
            // провайдеру и обратно.
            <Button key={provider} variant="outline" size="sm" asChild>
              <a href={identityLinkUrl(provider)}>Подключить {providerTitle(provider)}</a>
            </Button>
          ))}
        </div>
      )}

      {unlink.isError && (
        <p role="alert" className="text-sm text-destructive">
          Не удалось отключить. Попробуйте ещё раз.
        </p>
      )}
    </section>
  )
}

function linkOutcomeText(link: 'ok' | 'conflict' | 'expired' | 'failed'): string {
  switch (link) {
    case 'ok':
      return 'Способ входа подключён.'
    case 'conflict':
      return 'Этот аккаунт провайдера уже привязан.'
    case 'expired':
      return 'Привязка не завершена: сеанс истёк. Попробуйте ещё раз.'
    case 'failed':
      return 'Не удалось подключить. Попробуйте ещё раз.'
  }
}
