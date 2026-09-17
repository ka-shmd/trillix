import { useEffect, useState } from 'react'
import { z } from 'zod'

import './document.css'
import { PasswordGate } from '../form/PasswordGate'
import { type ConsentDocKind } from '../form/consent'
import { unlockHeaders } from '../form/unlock'

// Страница документа согласия или политики обработки персональных данных
// (design/privacy-consent.md §3.5). Открывается ссылкой из-под кнопки отправки в новой
// вкладке; адрес несёт ревизию и версию формы, и по этой паре текст однозначен.
//
// Уезжает ОТДЕЛЬНЫМ ЧАНКОМ со своим бюджетом (префикс document/): её открывает только
// тот, кто решил прочитать документ.
//
// У формы под паролем новая вкладка пароль спрашивает заново — токен разблокировки
// живёт «на вкладку» (design/form-password.md §2.4). Это то же правило, что у самой
// формы, открытой в новой вкладке.

const docSchema = z.object({ title: z.string(), text: z.string() })
type Doc = z.infer<typeof docSchema>

type State =
  | { status: 'loading' }
  | { status: 'ok'; doc: Doc }
  | { status: 'locked' }
  | { status: 'notfound' }
  | { status: 'error' }

export default function DocumentScreen({ slug, kind, search }: { slug: string; kind: ConsentDocKind; search: string }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    const url = `/public/v1/forms/${encodeURIComponent(slug)}/documents/${kind}${search}`
    void fetch(url, { headers: { Accept: 'application/json', ...unlockHeaders(slug) } })
      .then(async (res) => {
        if (!alive) return
        if (res.status === 404) return setState({ status: 'notfound' })
        if (res.status === 401) return setState({ status: 'locked' })
        if (!res.ok) return setState({ status: 'error' })
        const doc = docSchema.parse(await res.json())
        document.title = doc.title
        setState({ status: 'ok', doc })
      })
      .catch(() => alive && setState({ status: 'error' }))
    return () => {
      alive = false
    }
  }, [slug, kind, search, attempt])

  if (state.status === 'loading') return <Note>Загружаем документ…</Note>
  if (state.status === 'notfound') {
    return <Note>Документ не найден. Возможно, автор формы его обновил — откройте ссылку из формы заново.</Note>
  }
  if (state.status === 'locked') {
    return <PasswordGate slug={slug} title="Документ формы" badge={false} onUnlocked={() => setAttempt((n) => n + 1)} />
  }
  if (state.status === 'error') return <Note>Что-то пошло не так. Попробуйте обновить страницу.</Note>

  // Абзацы — через пустую строку, как их собирает сервер; одиночный перевод строки
  // внутри абзаца держит white-space: pre-wrap. Текст рендерится текстом (инвариант 4).
  const paragraphs = state.doc.text.split(/\n{2,}/).filter((p) => p.trim() !== '')
  return (
    <main className="doc">
      <h1 className="doc-title">{state.doc.title}</h1>
      {paragraphs.map((p, i) => (
        <p key={i} className="doc-text">
          {p}
        </p>
      ))}
    </main>
  )
}

function Note({ children }: { children: string }) {
  return (
    <main className="doc">
      <p className="doc-note">{children}</p>
    </main>
  )
}
