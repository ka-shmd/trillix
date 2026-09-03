import { useEffect, useRef, useState } from 'react'

import { HOLD_CONFLICT, HOLD_NO_SEATS, type FreeSlot, type SlotSource } from '../booking'
import { LOCALE } from '../locale'
import { fits, groupByDay, timeLabel, zoneNote, type SlotDay } from './slotList'
import './slots.css'

// Живой выбор времени — ЕДИНСТВЕННЫЙ модуль формы за динамическим импортом
// (ADR §10, бюджет 12 КиБ gzip под префиксом slots/). Качает его только тот, кто
// открыл форму с вопросом о записи; в общий бандл он не попадает.
//
// Месячной сетки календаря нет намеренно (§4.7 спеки): список ближайших дат, у каждой —
// времена. Так легче, так честнее на телефоне и так не нужен виджет с драгом.

// HORIZON_MS — сколько времени спрашиваем у сервера за раз. Год: горизонт расписания
// не больше 365 дней (CHECK миграции 0050), и второй запрос при листании дат означал бы
// ожидание там, где человек просто ведёт пальцем.
const HORIZON_MS = 366 * 24 * 60 * 60 * 1000

export type SlotPickerProps = {
  source: SlotSource
  // value — id брони, если время уже придержано: тогда пикер показывает выбранное и
  // кнопку «изменить», а не список.
  value: string
  onChange: (bookingId: string) => void
  label: string
  invalid: boolean
  errorId?: string
}

export default function SlotPicker(p: SlotPickerProps) {
  const [days, setDays] = useState<SlotDay[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [activeDay, setActiveDay] = useState<string | null>(null)
  const [seats, setSeats] = useState(1)
  const [held, setHeld] = useState<FreeSlot | null>(null)
  const [holding, setHolding] = useState('')
  const [refusal, setRefusal] = useState('')
  // reload — счётчик перезапросов: «повторить» после сбоя и обновление списка после
  // отказа «время только что заняли» (свободное успело измениться).
  const [reload, setReload] = useState(0)
  const source = useRef(p.source)
  source.current = p.source

  useEffect(() => {
    const ctl = new AbortController()
    const from = new Date().toISOString()
    const to = new Date(Date.now() + HORIZON_MS).toISOString()
    setFailed(false)
    source.current
      .list({ from, to, signal: ctl.signal })
      .then((slots) => {
        const grouped = groupByDay(slots)
        setDays(grouped)
        // Первый день с временами открыт сразу: список дат без раскрытого дня
        // требует лишнего клика ровно там, где выбор очевиден.
        setActiveDay((prev) => prev ?? grouped[0]?.key ?? null)
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return
        setFailed(true)
        void err
      })
    return () => ctl.abort()
  }, [reload])

  async function pick(slot: FreeSlot) {
    setRefusal('')
    setHolding(slot.startsAt)
    try {
      const { bookingId } = await source.current.hold({ startsAt: slot.startsAt, seats })
      setHeld(slot)
      p.onChange(bookingId)
    } catch (err: unknown) {
      // Тексты отказов утверждены владельцем (DEV-PLAN, фаза 27): это извинение
      // сервиса, а не ошибка валидации, — их читает клиент автора.
      const code = err instanceof Error ? err.message : ''
      if (code === HOLD_NO_SEATS) {
        setRefusal('На это время осталось меньше мест, чем вы выбрали. Выберите другое время или уменьшите число мест')
      } else if (code === HOLD_CONFLICT) {
        setRefusal('Это время только что заняли. Выберите, пожалуйста, другое: свободные варианты обновились')
      } else {
        setRefusal('Не удалось занять время. Попробуйте ещё раз')
      }
      // Список перезапрашивается на любом отказе: он устарел ровно тем, что отказ и
      // сообщает.
      setReload((n) => n + 1)
    } finally {
      setHolding('')
    }
  }

  if (p.value !== '' && held) {
    return (
      <div className="rf-slots" aria-label={p.label}>
        <div className="rf-slot">
          <span className="rf-slot-value">
            {new Date(held.startsAt).toLocaleString(LOCALE, {
              day: 'numeric',
              month: 'long',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {seats > 1 && ` · мест: ${seats}`}
          </span>
        </div>
        <button
          type="button"
          className="rf-slots-link"
          onClick={() => {
            // Отпускать холд не нужно: он протухнет сам, а место освободит счёт
            // занятого. Молча держать его до конца анкеты нельзя — человек выбирает
            // другое время, и первое обязано вернуться в оборот само.
            setHeld(null)
            setRefusal('')
            setReload((n) => n + 1)
          }}
        >
          Выбрать другое время
        </button>
      </div>
    )
  }

  const note = zoneNote(p.source.timezone)
  const day = days?.find((d) => d.key === activeDay) ?? null

  return (
    <div
      className="rf-slots"
      aria-label={p.label}
      aria-invalid={p.invalid || undefined}
      aria-describedby={p.invalid ? p.errorId : undefined}
    >
      {p.source.maxSeats > 1 && (
        <label className="rf-slots-seats">
          Мест
          <select
            className="rf-slots-select"
            value={String(seats)}
            onChange={(e) => setSeats(Number(e.currentTarget.value))}
          >
            {Array.from({ length: p.source.maxSeats }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}

      {days === null && !failed && <p className="rf-slots-note">Загружаем свободное время…</p>}

      {failed && (
        <p className="rf-slots-note" role="alert">
          Не удалось загрузить свободное время.{' '}
          <button type="button" className="rf-slots-link" onClick={() => setReload((n) => n + 1)}>
            Повторить
          </button>
        </p>
      )}

      {days?.length === 0 && (
        <p className="rf-slots-note">Свободного времени сейчас нет. Загляните позже.</p>
      )}

      {days && days.length > 0 && (
        <>
          {/* Даты — горизонтальная лента: их до года вперёд, и вертикальным списком
              они увели бы времена за экран. */}
          <div className="rf-slots-days" role="tablist" aria-label="Даты">
            {days.map((d) => (
              <button
                key={d.key}
                type="button"
                role="tab"
                aria-selected={d.key === activeDay}
                className={
                  d.key === activeDay ? 'rf-slots-day rf-slots-day--on' : 'rf-slots-day'
                }
                onClick={() => setActiveDay(d.key)}
              >
                {d.label}
              </button>
            ))}
          </div>

          <div className="rf-slots-times" role="group" aria-label="Время">
            {day?.slots.map((slot) => {
              const enough = fits(slot, seats)
              return (
                <button
                  key={slot.startsAt}
                  type="button"
                  disabled={!enough || holding !== ''}
                  className="rf-slots-time"
                  onClick={() => void pick(slot)}
                >
                  {timeLabel(slot.startsAt)}
                  {p.source.showRemaining && slot.remaining > 1 && (
                    <span className="rf-slots-left">осталось {slot.remaining}</span>
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}

      {refusal && (
        <p className="rf-slots-note rf-slots-note--bad" role="alert">
          {refusal}
        </p>
      )}
      {note && <p className="rf-slots-note">{note}</p>}
    </div>
  )
}
