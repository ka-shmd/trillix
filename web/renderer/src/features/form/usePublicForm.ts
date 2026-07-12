import { useEffect, useState } from 'react'

import { fetchPublicForm, type PublicForm } from './api'

// Состояние загрузки формы. Все три «экрана данных» (loading/error/notfound)
// обязательны — web/CLAUDE.md.
export type FormState =
  | { status: 'loading' }
  | { status: 'ok'; form: PublicForm }
  | { status: 'notfound' }
  | { status: 'error'; message: string }

// Загрузка опубликованной формы по slug. Без TanStack Query (зона экономии
// рендерера) — useState + useEffect. Пустой slug не ходит в сеть: сразу notfound.
export function usePublicForm(slug: string): FormState {
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
    fetchPublicForm(slug)
      .then((r) => {
        if (!active) return
        setState(r.status === 'ok' ? { status: 'ok', form: r.form } : { status: 'notfound' })
      })
      .catch((e: unknown) => {
        if (!active) return
        setState({ status: 'error', message: e instanceof Error ? e.message : 'неизвестная ошибка' })
      })
    return () => {
      active = false
    }
  }, [slug])

  return state
}
