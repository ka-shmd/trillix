import { useEffect, useState } from 'react'

import { fetchPublicForm, type PublicForm } from './api'
import { fetchFormToken, type FormToken } from './formToken'

// Состояние загрузки формы. Все три «экрана данных» (loading/error/notfound)
// обязательны — web/CLAUDE.md.
//
// token приезжает рядом с формой, но ОТДЕЛЬНЫМ запросом (ADR §10): тело схемы
// кэшируется, а токен обязан быть свежим. null означает «сервер этой странице не
// отвечает и не должен» — так выражен предпросмотр автора: без токена нет ни
// отправки, ни загрузки файлов, ни биконов, и проверять флаг предпросмотра в
// каждом из этих мест не нужно.
export type FormState =
  | { status: 'loading' }
  | { status: 'ok'; form: PublicForm; token: FormToken | null }
  | { status: 'closed'; title: string; message: string; showBadge: boolean }
  | { status: 'notfound' }
  | { status: 'error'; message: string }

// Загрузка опубликованной формы по slug. Без TanStack Query (зона экономии
// рендерера) — useState + useEffect. Пустой slug не ходит в сеть: сразу notfound.
//
// preview — предпросмотр автора (`?preview=1`): токен не запрашивается вовсе, потому
// что отправка в этом режиме останавливается до сети, а сама форма читается мимо
// кэша — живые настройки автор обязан видеть сразу (fetchPublicForm).
export function usePublicForm(slug: string, preview: boolean): FormState {
  // Пустой slug решается на рендере (не ходим в сеть) — без синхронного setState
  // в эффекте. Непустой начинает с loading, эффект догрузит.
  const [state, setState] = useState<FormState>(() =>
    slug === '' ? { status: 'notfound' } : { status: 'loading' },
  )

  useEffect(() => {
    if (slug === '') return
    // Начальное loading уже выставил инициализатор useState; повторно
    // синхронно его не ставим (slug из pathname постоянен на всё время жизни).
    let active = true
    // Параллельно, а не цепочкой: запросы независимы (токен не знает про форму), и
    // ждать один другого значило бы сложить их задержки на пути к первому экрану.
    //
    // Отказ ЛЮБОГО из двух — экран ошибки, а не форма без токена: без токена ответ
    // принять нельзя, и честнее сказать это сразу, чем дать человеку заполнить форму
    // и упереться в отказ на кнопке «Отправить».
    Promise.all([fetchPublicForm(slug, preview), preview ? Promise.resolve(null) : fetchFormToken()])
      .then(([r, token]) => {
        if (!active) return
        // fetchPublicForm уже разложил ответ на ok/closed/notfound — переносим как есть.
        setState(r.status === 'ok' ? { ...r, token } : r)
      })
      .catch((e: unknown) => {
        if (!active) return
        setState({
          status: 'error',
          message: e instanceof Error ? e.message : 'неизвестная ошибка',
        })
      })
    return () => {
      active = false
    }
  }, [slug, preview])

  return state
}
