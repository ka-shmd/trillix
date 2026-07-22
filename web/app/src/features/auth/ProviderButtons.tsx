import { useQuery } from '@tanstack/react-query'
import { providersQueryOptions } from './queries'
import { providerStartUrl } from './api'
import { Button } from '@/components/ui/button'

// Подписи известных провайдеров. Имя, которого здесь нет, не рисуется вовсе:
// бэк может добавить провайдера раньше фронта, и кнопка «vk» без подписи
// выглядела бы поломкой.
const PROVIDER_LABELS: Record<string, string> = {
  yandex: 'Войти через Яндекс',
}

// Кнопки входа через провайдеров над формой email+пароль. Пусто (ключей нет в
// окружении бэка или запрос не удался) — блок не рисуется совсем, и экран
// выглядит ровно как до фазы 11.
export function ProviderButtons() {
  const { data: providers } = useQuery(providersQueryOptions)

  const known = (providers ?? []).filter((name) => name in PROVIDER_LABELS)
  if (known.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {known.map((name) => (
        // Именно <a>, а не onClick+fetch: нужен полноценный переход браузера —
        // XHR за редиректом на домен провайдера не пойдёт.
        <Button key={name} asChild variant="outline" className="w-full">
          <a href={providerStartUrl(name)}>{PROVIDER_LABELS[name]}</a>
        </Button>
      ))}
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">или</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  )
}
