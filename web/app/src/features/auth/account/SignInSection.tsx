import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

import { providerTitle } from '../../../entities/identity'
import type { User } from '../../../entities/user'
import { ApiError } from '../../../shared/api/errors'
import { formatDate } from '../../../shared/format'
import { Section } from '../../../shared/page/Section'
import { useOAuthPopup, type OAuthOutcome } from '../../../shared/oauthPopup'
import { identityLinkUrl } from '../api'
import { OAuthWaitingDialog } from '../OAuthWaitingDialog'
import {
  identitiesQueryOptions,
  providersQueryOptions,
  useChangePassword,
  useRefreshIdentities,
  useUnlinkIdentity,
} from '../queries'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ErrorState } from '../../../shared/page/states'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'

// MIN_PASSWORD_LEN зеркалит minPasswordLen из internal/auth/service.go.
const MIN_PASSWORD_LEN = 8

export type LinkOutcomeParam = 'ok' | 'conflict' | 'expired' | 'failed'

// Способы входа — ОДИН список, и пароль стоит в нём строкой наравне с
// провайдерами. Пока смена пароля жила отдельным разделом выше, тот же факт
// («задан» или нет) сообщался в двух местах, и строка списка была единственной
// строкой без действия — она только повторяла соседний раздел.
//
// VK ID появится здесь новой строкой без правок: список строится из того, что
// подключено, и того, что вообще включено в окружении бэка.
export function SignInSection({
  user,
  link,
  onLinkOutcome,
  onLinkClear,
}: {
  user: User
  // link — исход возврата от провайдера, приезжает параметром адреса: колбэк это
  // навигация браузера, а не вызов API, и сказать «получилось» он может только им.
  //
  // ⚠ ПАРАМЕТР ОБЯЗАН УМЕТЬ ГАСНУТЬ. Диалог отказа открыт ровно пока он в адресе:
  // своего состояния «закрыт» у диалога нет — иначе после возврата из провайдера
  // полным переходом (попап заблокирован) его нечем было бы открыть.
  link?: LinkOutcomeParam
  onLinkOutcome: (outcome: LinkOutcomeParam) => void
  onLinkClear: () => void
}) {
  const identities = useQuery(identitiesQueryOptions)
  const providers = useQuery(providersQueryOptions)
  const unlink = useUnlinkIdentity()
  const refreshIdentities = useRefreshIdentities()
  const [changingPassword, setChangingPassword] = useState(false)
  // Провайдер текущего похода: нужен подписи «ждём подтверждения».
  const [started, setStarted] = useState('')

  const popup = useOAuthPopup((outcome) => {
    // Отказ у провайдера — не событие экрана настроек: человек сам передумал,
    // и показывать ему «не удалось подключить» значит врать.
    if (outcome === 'denied') return
    // Успех говорит тостом и НЕ пишется в адрес: подключённый способ виден
    // строкой списка, и метка «ok», застрявшая в адресной строке, пережила бы
    // событие, о котором сообщает.
    if (outcome === 'link_ok') {
      refreshIdentities()
      toast.success(`${providerTitle(started)} подключён.`)
      onLinkClear()
      return
    }
    onLinkOutcome(linkOutcome(outcome))
  })

  const connected = identities.data ?? []
  const available = (providers.data ?? []).filter((p) => !connected.some((c) => c.provider === p))
  // Последний способ войти снять нельзя — кнопку не рисуем и говорим почему.
  // Сервер ответит 409 в любом случае, но узнавать об этом из ошибки после
  // нажатия — плохой способ объяснять правило.
  const lastWayIn = !user.hasPassword && connected.length <= 1

  return (
    <Section title="Способы входа">
      {identities.isError ? (
        <ErrorState
          title="Не удалось загрузить способы входа."
          onRetry={() => void identities.refetch()}
        />
      ) : (
        <ul className="divide-y border-t">
          <li className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="min-w-0">
              <p className="text-base font-semibold">Пароль</p>
              <p className="text-sm text-muted-foreground">
                {user.hasPassword
                  ? 'Задан — вход по адресу почты и паролю'
                  : 'Не задан — вы входите только через провайдера'}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setChangingPassword(true)}>
              {user.hasPassword ? 'Сменить' : 'Задать пароль'}
            </Button>
          </li>

          {identities.isPending && (
            <li className="py-4" aria-busy>
              <Skeleton className="h-5 w-40" />
            </li>
          )}

          {connected.map((identity) => (
            <li
              key={identity.provider}
              className="flex flex-wrap items-center justify-between gap-3 py-4"
            >
              <div className="min-w-0">
                <p className="truncate text-base font-semibold">
                  {providerTitle(identity.provider)}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {identity.providerEmail !== '' && `${identity.providerEmail} · `}
                  подключён {formatDate(identity.connectedAt)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/8 hover:text-destructive"
                disabled={lastWayIn || unlink.isPending}
                onClick={() =>
                  unlink.mutate(identity.provider, {
                    onSuccess: () => toast.success(`${providerTitle(identity.provider)} отключён.`),
                    onError: () => toast.error('Не удалось отключить. Попробуйте ещё раз.'),
                  })
                }
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

      {/* Ожидание занимает экран целиком: настройки под ним не должны принимать
          ни клики, ни фокус. */}
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

      {/* Отказ привязки — ДИАЛОГ, а не строка на странице (решение владельца
          2026-09-08). Человек возвращается сюда из чужого окна, глядя на список
          способов входа, и объяснение «этот аккаунт уже привязан» стояло абзацем
          над списком: там его прочитывали не раньше, чем замечали, что новой
          строки не появилось. Диалог перехватывает возврат и называет причину. */}
      <LinkFailureDialog link={link} onClose={onLinkClear} />

      <PasswordDialog
        hasPassword={user.hasPassword}
        open={changingPassword}
        onOpenChange={setChangingPassword}
      />
    </Section>
  )
}

// PasswordDialog — «Сменить пароль», а у аккаунта через провайдера «Задать
// пароль»: пароля у него нет, текущий спрашивать не с чего, и доказательством
// служит живая сессия.
function PasswordDialog({
  hasPassword,
  open,
  onOpenChange,
}: {
  hasPassword: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const change = useChangePassword()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LEN
  const ready = next.length >= MIN_PASSWORD_LEN && (!hasPassword || current !== '')

  function close() {
    setCurrent('')
    setNext('')
    change.reset()
    onOpenChange(false)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready) return
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        // Диалог закрывается молча, поэтому об успехе говорит тост: иначе
        // единственным признаком смены пароля было бы исчезнувшее окно.
        //
        // Поля чистятся только на успехе: при неверном текущем пароле человек
        // должен видеть, что именно он вводил, а не пустую форму.
        onSuccess: () => {
          toast.success('Пароль изменён. На остальных устройствах придётся войти заново.')
          close()
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{hasPassword ? 'Сменить пароль' : 'Задать пароль'}</DialogTitle>
          <DialogDescription>
            {hasPassword
              ? 'Все остальные устройства выйдут из аккаунта, а на почту придёт уведомление.'
              : 'Сейчас вы входите через провайдера. Пароль позволит войти и без него.'}
          </DialogDescription>
        </DialogHeader>

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
                autoFocus
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
              autoFocus={!hasPassword}
            />
            <p
              className={
                tooShort ? 'mt-2 text-sm text-destructive' : 'mt-2 text-sm text-muted-foreground'
              }
            >
              Не короче {MIN_PASSWORD_LEN} символов.
            </p>
          </div>

          {change.isError && (
            <p role="alert" className="text-sm text-destructive">
              {passwordErrorText(change.error)}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Отмена
            </Button>
            <Button type="submit" disabled={!ready || change.isPending}>
              {change.isPending ? 'Сохраняем…' : hasPassword ? 'Сменить пароль' : 'Задать пароль'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

// linkOutcome переводит код исхода из отдельного окна в параметр экрана. Исход
// входа (провайдер вернул «нужен второй фактор» и подобное) сюда приехать может
// только из брошенного намерения — для настроек это общий отказ.
function linkOutcome(outcome: OAuthOutcome): LinkOutcomeParam {
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

// Диалог открыт ровно тогда, когда в адресе стоит отказ: своего состояния он не
// держит, и закрытие = снятие параметра. Успех сюда не попадает — он говорит
// тостом, а подключённый способ виден строкой списка.
function LinkFailureDialog({ link, onClose }: { link?: LinkOutcomeParam; onClose: () => void }) {
  const failure = link !== undefined && link !== 'ok' ? linkFailureText(link) : null

  return (
    <AlertDialog open={failure !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{failure?.title}</AlertDialogTitle>
          <AlertDialogDescription>{failure?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose}>Понятно</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// Провайдер в тексте не назван: после возврата ПОЛНЫМ переходом (попап
// заблокирован) вкладка не знает, с кем ходила, — знает только исход. Врать
// именем ради конкретики нельзя, а два текста на один отказ разъедутся.
function linkFailureText(link: 'conflict' | 'expired' | 'failed'): {
  title: string
  description: string
} {
  switch (link) {
    case 'conflict':
      return {
        title: 'Этот аккаунт уже привязан',
        description:
          'Аккаунт провайдера принадлежит только одному аккаунту Trillix, и этот занят другим. ' +
          'Если это ваш второй аккаунт — войдите через провайдера: вы попадёте именно в него.',
      }
    case 'expired':
      return {
        title: 'Привязка не завершена',
        description:
          'Подтверждение у провайдера заняло больше 15 минут, и начатая привязка истекла. ' +
          'Начните заново — это безопасно, ничего не изменилось.',
      }
    case 'failed':
      return {
        title: 'Не удалось подключить',
        description:
          'Провайдер не ответил или вернул отказ. Попробуйте ещё раз; если повторится — ' +
          'проверьте, что вы вошли у провайдера тем аккаунтом, который хотите привязать.',
      }
  }
}
