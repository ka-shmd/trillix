import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { z } from 'zod'

import {
  identitiesQueryOptions,
  meQueryOptions,
  providersQueryOptions,
  useChangePassword,
  useDeleteAccount,
  devicesQueryOptions,
  useDisableTwoFactor,
  useEnableTwoFactor,
  useForgetAllDevices,
  useForgetDevice,
  useRequestEmailChange,
  useSendActionCode,
  useRefreshIdentities,
  useUnlinkIdentity,
  useUpdateProfile,
  useUploadAvatar,
  useDeleteAvatar,
} from '../../features/auth/queries'
import { identityLinkUrl } from '../../features/auth/api'
import { useOAuthPopup, type OAuthOutcome } from '../../shared/oauthPopup'
import { OAuthWaitingDialog } from '../../features/auth/OAuthWaitingDialog'
import { providerTitle } from '../../entities/identity'
import { formatDate } from '../../shared/format'
import { UserAvatar } from '../../shared/UserAvatar'
import { ApiError } from '../../shared/api/errors'
import type { User } from '../../entities/user'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Страница «Аккаунт» (/settings/account). Фаза 23 DEV-PLAN целиком: профиль,
// адрес, пароль, способы входа, второй фактор и удаление аккаунта
// (docs/design/account-settings.md).
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
      <PageCrumbs items={['Настройки']} />
      <AccountForm key={user.id} user={user} />
      <EmailForm key={`email-${user.email}`} user={user} />
      <PasswordForm key={`pwd-${user.id}`} hasPassword={user.hasPassword} />
      <IdentitiesSection hasPassword={user.hasPassword} />
      <TwoFactorSection key={`2fa-${user.twoFactorEnabled}`} user={user} />
      <DeleteAccountSection user={user} />
    </div>
  )
}

// DeleteAccountSection — удаление аккаунта (слайс G). Форма подтверждения
// закрыта, пока человек не нажал «Удалить аккаунт»: это единственное необратимое
// действие на странице, и стоять раскрытым рядом с полями профиля ему незачем.
function DeleteAccountSection({ user }: { user: User }) {
  const remove = useDeleteAccount()
  const navigate = Route.useNavigate()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')

  // Пароль спрашиваем, если он есть; код — если включён второй фактор. Сервер
  // проверяет то же самое: у аккаунта через провайдера без фактора
  // доказательством служит сама сессия.
  const ready =
    (!user.hasPassword || password !== '') && (!user.twoFactorEnabled || code.trim() !== '')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready) return
    remove.mutate(
      { currentPassword: password, code: code.trim() },
      { onSuccess: () => navigate({ to: '/login' }) },
    )
  }

  return (
    <section className="flex flex-col gap-4 border-t pt-8">
      <div>
        <h2 className="text-lg font-medium">Удаление аккаунта</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Вход перестанет работать, а опубликованные формы — открываться и принимать ответы.
          Отменить это самостоятельно нельзя, и адрес {user.email} останется занятым: завести на
          него новый аккаунт не получится.
        </p>
      </div>

      {!open ? (
        <div>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Удалить аккаунт
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {user.hasPassword && (
            <div>
              <Label htmlFor="delete-password" className="mb-2 block">
                Текущий пароль
              </Label>
              <Input
                id="delete-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          {user.twoFactorEnabled && (
            <CodeField id="delete-code" value={code} onChange={setCode} />
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" variant="destructive" disabled={!ready || remove.isPending}>
              {remove.isPending ? 'Удаляем…' : 'Удалить аккаунт навсегда'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
          </div>

          {remove.isError && (
            <p role="alert" className="text-sm text-destructive">
              {deleteErrorText(remove.error)}
            </p>
          )}
        </form>
      )}
    </section>
  )
}

function deleteErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Пароль или код не подошли. Проверьте и попробуйте ещё раз.'
      // 409 здесь ровно один: человек — владелец командного пространства, в
      // котором остались люди. Имена пространств есть в списке пространств, и
      // тащить их сюда из текста ошибки незачем.
      case 'conflict':
        return 'Вы владелец командных пространств, в которых есть участники. Передайте владение или удалите эти пространства.'
      case 'rate_limited':
        return 'Слишком много попыток. Подождите минуту и попробуйте снова.'
    }
  }
  return 'Не удалось удалить аккаунт. Попробуйте ещё раз.'
}

// AvatarSection — фото профиля. Кадрировать нечего: кружок обрезает картинку по
// короткой стороне сам (object-cover), а сервер только ужимает её до 512 по
// длинной — редактор кадра это отдельная работа со своим контролом.
function AvatarSection({ user }: { user: User }) {
  const upload = useUploadAvatar()
  const remove = useDeleteAvatar()
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // позволить выбрать тот же файл повторно
    if (!file) return
    setError(null)
    upload.mutate(file, { onError: (err) => setError(avatarErrorText(err)) })
  }

  const busy = upload.isPending || remove.isPending

  return (
    <div className="flex items-center gap-4">
      {/* Нативный файловый диалог — тот случай, когда системный контрол лучше
          своего (web/CLAUDE.md); сам input спрятан, его открывает кнопка. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={onFile}
      />
      <UserAvatar person={user} className="size-16 rounded-full text-xl" />
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {upload.isPending
              ? 'Загружаем…'
              : user.avatarKey === ''
                ? 'Загрузить фото'
                : 'Заменить'}
          </Button>
          {user.avatarKey !== '' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setError(null)
                remove.mutate(undefined, { onError: (err) => setError(avatarErrorText(err)) })
              }}
            >
              Удалить
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          PNG или JPEG, до 5 МБ. Без фото — кружок с инициалами.
        </p>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

function avatarErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'payload_too_large':
        return 'Файл больше 5 МБ.'
      case 'validation_failed':
        return 'Не похоже на картинку. Нужен PNG или JPEG.'
      case 'rate_limited':
        return 'Слишком часто. Подождите минуту и попробуйте снова.'
    }
  }
  return 'Не удалось сохранить фото. Попробуйте ещё раз.'
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

      <AvatarSection user={user} />

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
  const [code, setCode] = useState('')

  // Тот же состав подтверждения, что у удаления аккаунта: пароль, если он есть,
  // и код, если включён фактор. Смена адреса уводит канал восстановления, и по
  // последствиям она ближе к удалению, чем к правке профиля.
  const ready =
    email.trim() !== '' &&
    (!user.hasPassword || password !== '') &&
    (!user.twoFactorEnabled || code.trim() !== '')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready) return
    request.mutate(
      { newEmail: email.trim(), currentPassword: password, code: code.trim() },
      {
        onSuccess: () => {
          setPassword('')
          setCode('')
        },
      },
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
          {user.emailVerified ? ' — подтверждён.' : ' — не подтверждён.'} На него приходят письма и
          восстановление доступа.
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
        {user.twoFactorEnabled && <CodeField id="email-code" value={code} onChange={setCode} />}

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
      // Отказ один на оба подтверждения — сервер не различает «пароль не тот» и
      // «код не тот» намеренно, и формулировка обязана это выдерживать.
      case 'invalid_credentials':
        return 'Пароль или код не подошли. Проверьте и попробуйте ещё раз.'
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
  const navigate = Route.useNavigate()
  const identities = useQuery(identitiesQueryOptions)
  const providers = useQuery(providersQueryOptions)
  const unlink = useUnlinkIdentity()
  const refreshIdentities = useRefreshIdentities()
  // Провайдер текущего похода: нужен подписи «ждём подтверждения».
  const [started, setStarted] = useState('')

  const popup = useOAuthPopup((outcome) => {
    // Отказ у провайдера — не событие экрана настроек: человек сам передумал,
    // и показывать ему «не удалось подключить» значит врать.
    if (outcome === 'denied') return
    if (outcome === 'link_ok') refreshIdentities()
    navigate({ to: '/settings/account', search: { link: linkOutcome(outcome) } })
  })

  const connected = identities.data ?? []
  const available = (providers.data ?? []).filter((p) => !connected.some((c) => c.provider === p))
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
              <p className="text-sm text-muted-foreground">{hasPassword ? 'Задан' : 'Не задан'}</p>
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

      {/* Ожидание занимает экран целиком: настройки под ним не должны
          принимать ни клики, ни фокус. */}
      {popup.waiting && <OAuthWaitingDialog provider={started} onCancel={popup.cancel} />}

      {available.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {available.map((provider) => (
            // Ссылка, а не кнопка с fetch: браузеру нужен полноценный переход к
            // провайдеру и обратно. Клик пробует открыть отдельное окно и гасит
            // переход, только если это удалось: не вышло (блокировщик попапов,
            // узкий экран) — ссылка отрабатывает как раньше.
            <Button key={provider} variant="outline" size="sm" asChild>
              <a
                href={identityLinkUrl(provider)}
                onClick={(e) => {
                  setStarted(provider)
                  if (popup.open(identityLinkUrl(provider, true))) e.preventDefault()
                }}
              >
                Подключить {providerTitle(provider)}
              </a>
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

// linkOutcome переводит код исхода из отдельного окна в параметр экрана.
// Исход входа (провайдер вернул «нужен второй фактор» и подобное) сюда приехать
// может только из брошенного намерения — для настроек это общий отказ.
function linkOutcome(outcome: OAuthOutcome): 'ok' | 'conflict' | 'expired' | 'failed' {
  switch (outcome) {
    case 'link_ok':
      return 'ok'
    case 'link_conflict':
      return 'conflict'
    case 'link_expired':
      return 'expired'
    default:
      return 'failed'
  }
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

// CodeField — поле кода из письма с кнопкой «прислать». Общее для трёх форм
// (смена адреса, удаление аккаунта, выключение фактора): у аккаунта с включённым
// фактором код взять больше негде, и форма, спрашивающая его без кнопки, была бы
// тупиком.
function CodeField({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (v: string) => void
}) {
  const send = useSendActionCode()
  return (
    <div>
      <Label htmlFor={id} className="mb-2 block">
        Код из письма
      </Label>
      <div className="flex items-start gap-2">
        <Input
          id={id}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="123456"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => send.mutate()}
          disabled={send.isPending}
        >
          {send.isPending ? 'Отправляем…' : 'Прислать код'}
        </Button>
      </div>
      {send.isSuccess && !send.isPending && (
        <p className="mt-2 text-sm text-muted-foreground">
          Письмо с кодом отправлено. Оно приходит в течение минуты.
        </p>
      )}
      {send.isError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {twoFactorErrorText(send.error)}
        </p>
      )}
    </div>
  )
}

// TwoFactorSection — второй фактор: код на почту при входе с незнакомого
// устройства (docs/design/two-factor-email.md). Ремаунт по флагу сбрасывает
// поле пароля, когда фактор включился или выключился.
function TwoFactorSection({ user }: { user: User }) {
  const enable = useEnableTwoFactor()
  const disable = useDisableTwoFactor()
  const [password, setPassword] = useState('')
  const on = user.twoFactorEnabled
  const pending = enable.isPending || disable.isPending
  // Пароль спрашиваем, только если он есть: у аккаунта через провайдера
  // доказательством служит сама сессия, как и везде в настройках.
  const ready = !user.hasPassword || password !== ''

  return (
    <section className="flex flex-col gap-4 border-t pt-8">
      <div>
        <h2 className="text-lg font-medium">Двухфакторная аутентификация</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {on
            ? 'При входе с нового устройства после пароля запрашивается код из письма. На этом компьютере код спрашивать не будем.'
            : 'Вход с незнакомого устройства будет требовать код, отправленный на почту аккаунта.'}
        </p>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!ready) return
          const body = { currentPassword: password }
          if (on) disable.mutate(body)
          else enable.mutate(body)
        }}
      >
        {user.hasPassword && (
          <div>
            <Label htmlFor="2fa-password" className="mb-2 block">
              Текущий пароль
            </Label>
            <Input
              id="2fa-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}
        <div>
          <Button type="submit" variant={on ? 'outline' : 'default'} disabled={!ready || pending}>
            {pending ? 'Сохраняем…' : on ? 'Выключить' : 'Включить'}
          </Button>
        </div>
        {(enable.isError || disable.isError) && (
          <p role="alert" className="text-sm text-destructive">
            {twoFactorErrorText(enable.error ?? disable.error)}
          </p>
        )}
      </form>

      {on && <DevicesList />}
    </section>
  )
}

// DevicesList — устройства, которым код больше не нужен. Показывается только при
// включённом факторе: с выключенным строк нет и быть не может (бэк забывает их
// при выключении).
function DevicesList() {
  const { data: devices, isPending, isError } = useQuery(devicesQueryOptions)
  const forget = useForgetDevice()
  const forgetAll = useForgetAllDevices()

  if (isPending) return <p className="text-sm text-muted-foreground">Загружаем устройства…</p>
  if (isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Не удалось загрузить список устройств.
      </p>
    )
  }
  if (devices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Знакомых устройств пока нет: код спросят при первом входе с любого браузера.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">Устройства без кода</h3>
      <ul className="divide-y rounded-lg border">
        {devices.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm">
                {d.label}
                {d.current && <span className="text-muted-foreground"> · это устройство</span>}
              </p>
              <p className="text-sm text-muted-foreground">
                последний вход {formatDate(d.lastSeenAt)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => forget.mutate(d.id)}
              disabled={forget.isPending}
            >
              Забыть
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button variant="outline" onClick={() => forgetAll.mutate()} disabled={forgetAll.isPending}>
          {forgetAll.isPending ? 'Забываем…' : 'Забыть все и выйти на других устройствах'}
        </Button>
        <p className="mt-2 text-sm text-muted-foreground">
          Все сеансы, кроме текущего, будут завершены.
        </p>
      </div>
    </div>
  )
}

function twoFactorErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Код или пароль не подошли. Проверьте и попробуйте ещё раз.'
      case 'conflict':
        return 'Второй фактор уже включён. Обновите страницу.'
      case 'rate_limited':
        return 'Слишком много попыток. Подождите и попробуйте снова.'
    }
  }
  return 'Не получилось. Попробуйте ещё раз.'
}
