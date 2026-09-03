import { useEffect, useState } from 'react'
import { z } from 'zod'

import './cancel.css'

// Страница отмены записи (фаза 27, слайс H). Открывается по ссылке из письма; право
// предъявляет подписанный токен в адресе — ни сессии, ни пароля у респондента нет.
//
// Уезжает ОТДЕЛЬНЫМ ЧАНКОМ со своим бюджетом (префикс cancel/), по тому же доводу, что
// пикер времени: её качает только тот, кто пришёл отменять, а у формы запаса до порога
// меньше килобайта.
//
// Чужих ответов, имён и контактов здесь нет и быть не может — только то, что человеку
// и так прислали письмом: время, длительность и название формы.

const cardSchema = z.object({
  startsAt: z.string(),
  durationMinutes: z.number().int(),
  seats: z.number().int(),
  formTitle: z.string(),
  timezone: z.string(),
  canceled: z.boolean(),
})
type Card = z.infer<typeof cardSchema>

type State =
  | { status: 'loading' }
  | { status: 'ok'; card: Card }
  | { status: 'gone' }
  | { status: 'error' }

export default function CancelScreen({ token }: { token: string }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const base = `/public/v1/bookings/${encodeURIComponent(token)}`

  useEffect(() => {
    let alive = true
    void fetch(base, { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!alive) return
        // 410 — ссылка не действует: протухла, подделана или записи больше нет.
        // Различать эти случаи человеку незачем, действие у него одно.
        if (res.status === 410) return setState({ status: 'gone' })
        if (!res.ok) return setState({ status: 'error' })
        setState({ status: 'ok', card: cardSchema.parse(await res.json()) })
      })
      .catch(() => alive && setState({ status: 'error' }))
    return () => {
      alive = false
    }
  }, [base])

  async function cancel() {
    setBusy(true)
    try {
      const res = await fetch(`${base}/cancel`, { method: 'POST' })
      if (res.status === 410) return setState({ status: 'gone' })
      if (!res.ok) return setState({ status: 'error' })
      setState({ status: 'ok', card: cardSchema.parse(await res.json()) })
    } catch {
      setState({ status: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (state.status === 'loading') return <Note>Загружаем запись…</Note>
  if (state.status === 'gone') {
    return (
      <Note>
        Ссылка на отмену больше не действует. Напишите автору формы — он отменит запись
        сам.
      </Note>
    )
  }
  if (state.status === 'error') return <Note>Что-то пошло не так. Попробуйте обновить страницу.</Note>

  const { card } = state
  return (
    <div className="cx">
      <p className="cx-form">{card.formTitle}</p>
      <p className="cx-when">{whenLabel(card)}</p>
      {card.seats > 1 && <p className="cx-note">Мест: {card.seats}</p>}

      {card.canceled ? (
        <p className="cx-done">Запись отменена, время снова свободно.</p>
      ) : (
        <>
          <button type="button" className="rf-submit" disabled={busy} onClick={() => void cancel()}>
            {busy ? 'Отменяем…' : 'Отменить запись'}
          </button>
          <p className="cx-note">
            После отмены это время снова смогут занять другие. Записаться заново можно той
            же формой.
          </p>
        </>
      )}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="cx">
      <p className="cx-note">{children}</p>
    </div>
  )
}

// whenLabel — когда встреча. Время пишется в поясе ЧИТАТЕЛЯ, и пояс расписания
// называется отдельной строкой только при расхождении: у большинства он тот же, и
// лишняя строка объясняла бы то, чего никто не спрашивал.
function whenLabel(card: Card): string {
  const at = new Date(card.startsAt)
  const day = at.toLocaleString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
  const theirs = at.toLocaleTimeString('ru-RU', {
    timeZone: card.timezone,
    hour: '2-digit',
    minute: '2-digit',
  })
  const mine = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  return theirs === mine ? day : `${day} (${theirs} у мастера)`
}
