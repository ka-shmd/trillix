import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { adoptPopupSession, providersQueryOptions } from './queries'
import { providerStartUrl } from './api'
import { useOAuthPopup, type OAuthOutcome } from './oauthPopup'
import { providerTitle } from '../../entities/identity'
import { Button } from '@/components/ui/button'

// Подписи известных провайдеров. Имя, которого здесь нет, не рисуется вовсе:
// бэк может добавить провайдера раньше фронта, и кнопка «vk» без подписи
// выглядела бы поломкой.
const PROVIDER_LABELS: Record<string, string> = {
  yandex: 'Войти через Яндекс',
}

// Причины отказа, которые умеет показать экран входа (см. routes/_auth/login).
const LOGIN_REASONS = [
  'denied',
  'expired',
  'state',
  'no_email',
  'failed',
  'provider_only',
] as const

type LoginReason = (typeof LOGIN_REASONS)[number]

// Исход, которого экран входа не знает (коды привязки из настроек — их может
// принести брошенное там намерение), показываем как общий отказ.
function loginReason(outcome: OAuthOutcome): LoginReason {
  return LOGIN_REASONS.includes(outcome as LoginReason) ? (outcome as LoginReason) : 'failed'
}

// Кнопки входа через провайдеров над формой email+пароль. Пусто (ключей нет в
// окружении бэка или запрос не удался) — блок не рисуется совсем, и экран
// выглядит ровно как до фазы 11.
export function ProviderButtons() {
  const { data: providers } = useQuery(providersQueryOptions)
  const navigate = useNavigate()
  const qc = useQueryClient()
  // Провайдер текущего похода: код исхода его не несёт, а подписи ожидания и
  // экрану привязки имя нужно.
  const [started, setStarted] = useState('')

  const popup = useOAuthPopup((outcome) => {
    switch (outcome) {
      case 'ok':
        adoptPopupSession(qc)
        navigate({ to: '/' })
        break
      case 'two_factor':
        navigate({ to: '/two-factor' })
        break
      case 'link_required':
        navigate({ to: '/link-account', search: { provider: started } })
        break
      default:
        navigate({ to: '/login', search: { oauth: loginReason(outcome) } })
    }
  })

  const known = (providers ?? []).filter((name) => name in PROVIDER_LABELS)
  if (known.length === 0) return null

  // Разделитель «или» рисуется в обоих состояниях: без него блок прыгал бы на
  // время ожидания.
  const divider = (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted-foreground">или</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )

  if (popup.waiting) {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm text-muted-foreground">
          Ждём подтверждения в окне {providerTitle(started)}. Не закрывайте эту
          вкладку.
        </p>
        <Button variant="outline" className="w-full" onClick={popup.cancel}>
          Отменить
        </Button>
        {divider}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {known.map((name) => (
        // Именно <a>, а не onClick+fetch: нужен полноценный переход браузера —
        // XHR за редиректом на домен провайдера не пойдёт. Клик пробует открыть
        // отдельное окно и гасит переход, только если это удалось: не вышло
        // (блокировщик попапов, узкий экран) — ссылка отрабатывает как раньше.
        <Button key={name} asChild variant="outline" className="w-full">
          <a
            href={providerStartUrl(name)}
            onClick={(e) => {
              setStarted(name)
              if (popup.open(providerStartUrl(name, true))) e.preventDefault()
            }}
          >
            {PROVIDER_LABELS[name]}
          </a>
        </Button>
      ))}
      {divider}
    </div>
  )
}
