import { useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import {
  OAUTH_MESSAGE_SOURCE,
  oauthOutcomeSchema,
  type OAuthOutcome,
} from '../features/auth/oauthPopup'

// Служебный экран отдельного окна входа. Колбэк бэка возвращает браузер сюда,
// когда поход был начат из окна (?mode=popup): рисовать кабинет в окне 560×680
// незачем, окно — гонец. Отдаёт код исхода вкладке-опекуну и закрывается.
//
// Верхнеуровневый маршрут, вне _auth и _app: сюда приезжают и с открытой
// сессией (успех), и без неё (отказ провайдера), а любой гард увёл бы окно на
// свой экран вместо того, чтобы дать ему передать исход.
//
// Мусор в параметре гасит catch и превращается в «не удалось» — окно, зависшее
// на непонятном адресе, хуже честного отказа.
const doneSearchSchema = z.object({
  r: oauthOutcomeSchema.optional().catch(undefined),
})

export const Route = createFileRoute('/oauth/done')({
  validateSearch: doneSearchSchema,
  component: OAuthDonePage,
})

// screenFor — экран для случая, когда опекуна нет. Зеркалит oauthScreen из
// internal/auth/handler_oauth.go, кроме имени провайдера: его знает только
// вкладка, которая окно открывала.
function screenFor(outcome: OAuthOutcome): string {
  switch (outcome) {
    case 'ok':
      return '/'
    case 'two_factor':
      return '/two-factor'
    case 'link_required':
      return '/link-account'
    case 'link_ok':
    case 'link_conflict':
    case 'link_expired':
    case 'link_failed':
      return '/settings/account?link=' + outcome.slice('link_'.length)
    case 'integration_ok':
    case 'integration_denied':
    case 'integration_expired':
    case 'integration_forbidden':
    case 'integration_failed':
      // Опекуна нет, а какая форма подключалась — знала только вкладка,
      // открывшая окно. Список форм — ближайший честный экран; исход человек
      // увидит в табе «Интеграции», когда откроет форму.
      return '/forms'
    default:
      return '/login?oauth=' + outcome
  }
}

function OAuthDonePage() {
  const { r } = Route.useSearch()

  useEffect(() => {
    const outcome = r ?? 'failed'

    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(
        { source: OAUTH_MESSAGE_SOURCE, outcome },
        // Адресат — только свой origin: иначе исход входа уехал бы тому, кто
        // подсунул ссылку на этот экран из своего окна.
        window.location.origin,
      )
      window.close()
      return
    }

    // Опекуна нет: окно потеряло связь со вкладкой, или адрес открыли руками.
    // Тогда это обычная вкладка, и человека нужно довести до экрана самому —
    // бросать его на пустой служебной странице нельзя.
    window.location.replace(screenFor(outcome))
  }, [r])

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <p className="text-sm text-muted-foreground">Готово, окно можно закрыть.</p>
    </main>
  )
}
