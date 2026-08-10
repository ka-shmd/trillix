import { useEffect, useState } from 'react'

import { DEFAULT_THANK_YOU_TITLE } from '@entities/formSchema'

import { Badge } from './Badge'
import { type HostBridge } from './embed'
import { planThankYou } from './thankYouPlan'

// Экран «после отправки». Оба поля — из схемы той версии, по которой респондент
// отправил ответ (схема снапшотится при публикации), поэтому правка настроек
// владельцем задним числом этот экран не меняет. Всё решение (что показать, уходить
// ли и когда) — в чистой planThankYou; здесь только рендер и переход.
//
// Текст владельца рендерится как текст: React экранирует, dangerouslySetInnerHTML
// в репозитории запрещён (инвариант 4).
export function ThankYou({
  text,
  redirectUrl,
  bridge,
  badge,
}: {
  text: string
  redirectUrl: string
  bridge: HostBridge | null
  /** Бейдж площадки: решение сервера, то же, что на самой форме. */
  badge: boolean
}) {
  const { message, target, delayMs } = planThankYou(text, redirectUrl)
  // Ссылка-запасной путь показывается, когда переход уже запущен: если он не
  // случится (заблокирован в iframe, вкладка в фоне), человек не окажется в тупике.
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    if (!target) return
    // ВО ФРЕЙМЕ (фаза 20) переход делает хост: window.location внутри фрейма увёл бы
    // человека в сайт внутри сайта, оставив на чужой странице чужую шапку вокруг.
    // Послушался ли хост, нам не сообщают, поэтому запасную ссылку показываем сразу —
    // владелец сайта мог поставить data-redirect="frame" или не подключить скрипт вовсе.
    const go = bridge
      ? () => {
          setStalled(true)
          bridge.redirect(target)
        }
      : () => window.location.assign(target)
    if (delayMs === 0) {
      go()
      return
    }
    const timer = setTimeout(() => {
      setStalled(true)
      go()
    }, delayMs)
    return () => clearTimeout(timer)
  }, [target, delayMs, bridge])

  return (
    <main className="status">
      <h1 className="status-title">{DEFAULT_THANK_YOU_TITLE}</h1>
      <p className="status-detail">{message}</p>
      {target && (
        <p className="status-detail">
          {stalled ? <a href={target}>Перейти на сайт</a> : 'Сейчас перенаправим…'}
        </p>
      )}
      {badge && <Badge />}
    </main>
  )
}
