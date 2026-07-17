import { useEffect, useState } from 'react'

import { DEFAULT_THANK_YOU_TITLE } from '@entities/formSchema'

import { planThankYou } from './thankYouPlan'

// Экран «после отправки». Оба поля — из схемы той версии, по которой респондент
// отправил ответ (схема снапшотится при публикации), поэтому правка настроек
// владельцем задним числом этот экран не меняет. Всё решение (что показать, уходить
// ли и когда) — в чистой planThankYou; здесь только рендер и переход.
//
// Текст владельца рендерится как текст: React экранирует, dangerouslySetInnerHTML
// в репозитории запрещён (инвариант 4).
export function ThankYou({ text, redirectUrl }: { text: string; redirectUrl: string }) {
  const { message, target, delayMs } = planThankYou(text, redirectUrl)
  // Ссылка-запасной путь показывается, когда переход уже запущен: если он не
  // случится (заблокирован в iframe, вкладка в фоне), человек не окажется в тупике.
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    if (!target) return
    if (delayMs === 0) {
      window.location.assign(target)
      return
    }
    const timer = setTimeout(() => {
      setStalled(true)
      window.location.assign(target)
    }, delayMs)
    return () => clearTimeout(timer)
  }, [target, delayMs])

  return (
    <main className="status">
      <h1 className="status-title">{DEFAULT_THANK_YOU_TITLE}</h1>
      <p className="status-detail">{message}</p>
      {target && (
        <p className="status-detail">
          {stalled ? <a href={target}>Перейти на сайт</a> : 'Сейчас перенаправим…'}
        </p>
      )}
    </main>
  )
}
