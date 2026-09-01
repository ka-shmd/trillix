import { useState } from 'react'

import { Badge } from '@fields/Badge'
import { unlockForm } from './unlock'

// Экран ввода пароля: всё, что респондент видит у формы под паролем, пока пароль
// не назван (docs/design/form-password.md).
//
// Название формы на нём ВИДНО (решение владельца 2026-09-01, §2.3): пароль прячет
// вопросы и ответы, а не факт существования формы, — так же, как у Tally.
//
// Схемы формы в браузере на этом экране НЕТ ВОВСЕ: сервер её не прислал. Спрятать
// разметкой было бы не паролем, а ширмой — вопросы лежали бы в DOM.
export function PasswordGate({
  slug,
  title,
  badge,
  onUnlocked,
}: {
  slug: string
  title: string
  badge: boolean
  /** Пароль принят: вызывающий перезапрашивает форму — токен уже сохранён. */
  onUnlocked: () => void
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault()
    if (busy || password === '') return
    setBusy(true)
    setError('')
    unlockForm(slug, password)
      .then((r) => {
        if (r.status === 'ok') {
          onUnlocked()
          // Кнопку отпускаем и на успехе. Обычно этот экран тут же сменится формой,
          // и состояние никого не волнует, — но если перезапрос снова упрётся в 401
          // (токен не сохранился, автор сменил пароль в эту же секунду), экран
          // остался бы с вечным «Проверяем…» и недоступной кнопкой.
          setBusy(false)
          return
        }
        // Причина отказа человеку одна и та же — «пароль не подошёл»: различать
        // «неверный» и «у формы нет пароля» незачем, а исчерпанные попытки надо
        // назвать честно, иначе человек будет жать кнопку в пустоту.
        setError(
          r.status === 'limited'
            ? 'Слишком много попыток. Подождите минуту и попробуйте снова.'
            : 'Пароль не подошёл.',
        )
        setBusy(false)
      })
      .catch(() => {
        setError('Не удалось проверить пароль — проверьте соединение.')
        setBusy(false)
      })
  }

  return (
    <main className="status">
      <h1 className="status-title">{title}</h1>
      <p className="status-detail">Форма защищена паролем.</p>
      <form className="rf-gate" onSubmit={submit}>
        <label className="rf-gate-label" htmlFor="form-password">
          Пароль
        </label>
        <input
          id="form-password"
          className="rf-input"
          type="password"
          // Менеджеру паролей здесь подсказывать нечего: это общий секрет формы, а
          // не учётная запись человека, и предлагать сохранить его под нашим доменом
          // значило бы засорять его хранилище чужой строкой.
          autoComplete="off"
          autoFocus
          value={password}
          onChange={(e) => setPassword((e.target as HTMLInputElement).value)}
          aria-invalid={error !== ''}
          aria-describedby={error === '' ? undefined : 'form-password-error'}
        />
        {error !== '' && (
          <p className="rf-error" id="form-password-error" role="alert">
            {error}
          </p>
        )}
        <button className="rf-submit" type="submit" disabled={busy || password === ''}>
          {busy ? 'Проверяем…' : 'Открыть форму'}
        </button>
      </form>
      {badge && <Badge />}
    </main>
  )
}
