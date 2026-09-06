import { useEffect, useRef, useState } from 'react'

import { HOLD_CONFLICT, HOLD_NO_SEATS, type FreeSlot, type SlotSource } from '../booking'
import { LOCALE } from '../locale'
import { Chevron } from './Chevron'
import { useCols } from './cols'
import {
  dayStrip,
  fits,
  fullDayLabel,
  groupByDay,
  monthLabel,
  timeLabel,
  zoneNote,
  type DayCell,
} from './slotList'
import './slots.css'

// Живой выбор времени — ЕДИНСТВЕННЫЙ модуль формы за динамическим импортом
// (ADR §10, бюджет 12 КиБ gzip под префиксом slots/). Качает его только тот, кто
// открыл форму с вопросом о записи; в общий бандл он не попадает.
//
// Две секции, верхняя и нижняя (решение владельца 2026-09-06). Сверху — лента дат
// квадратами (число, под ним день недели) во всю ширину блока; месяц и шевроны — в
// строке над ней. Снизу — сетка времён выбранного дня: без своей прокрутки и без
// карусели, времена одного дня помещаются целиком.
//
// Месячной сетки календаря по-прежнему нет (§4.7 спеки): лента показывает дни подряд
// и листается страницами, а не рисует месяц с пустыми клетками до первого числа.
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
  const [cells, setCells] = useState<DayCell[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [start, setStart] = useState(0)
  // cols — сколько квадратов в странице ленты. Считается от ширины САМОЙ ленты, а не
  // задано числом: лента идёт во всю ширину блока, а блок у формы автора любой.
  const { cols, ref: week } = useCols()
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
  // Зеркало выбранного дня для эффекта: перезапрос приходит туда, где состояния не
  // видно, а вернуть человека в начало ленты после отказа «время заняли» — значит
  // отнять у него страницу, до которой он долистал.
  const chosen = useRef<string | null>(null)

  function selectDay(key: string | null) {
    chosen.current = key
    setActiveDay(key)
  }

  // shown — начало показанной страницы. Состояние прижимается к концу ленты здесь, а не
  // при записи: ширина ленты меняется на ходу (поворот телефона), и страница, законная
  // при семи квадратах, оказывается за концом при двенадцати.
  const shown = cells === null ? 0 : Math.min(start, lastStart(cells.length, cols))

  useEffect(() => {
    const ctl = new AbortController()
    const from = new Date().toISOString()
    const to = new Date(Date.now() + HORIZON_MS).toISOString()
    setFailed(false)
    source.current
      .list({ from, to, signal: ctl.signal })
      .then((slots) => {
        const strip = dayStrip(groupByDay(slots))
        // Прежний день остаётся выбранным, если в нём ещё есть свободное; иначе
        // открыт первый свободный — список дат без раскрытого дня требует лишнего
        // клика ровно там, где выбор очевиден.
        const prev = chosen.current
        const keep = prev !== null && strip.some((c) => c.key === prev && c.slots.length > 0)
        const next = keep ? prev : (strip.find((c) => c.slots.length > 0)?.key ?? null)
        const at = next === null ? 0 : strip.findIndex((c) => c.key === next)
        setCells(strip)
        selectDay(next)
        setStart(Math.floor(Math.max(at, 0) / cols) * cols)
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return
        setFailed(true)
        void err
      })
    return () => ctl.abort()
  }, [reload])

  // Листание НЕ трогает выбранный день (решение владельца 2026-09-06): человек листает,
  // чтобы посмотреть, а не чтобы переставить свой выбор. Выбранный день продолжает
  // держать сетку времён под лентой, даже когда сам уехал за край страницы.
  function turn(step: number) {
    if (!cells) return
    setStart(Math.min(Math.max(shown + step * cols, 0), lastStart(cells.length, cols)))
  }

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

  // ⚠ ОТВЕТ ЧИСТИТСЯ ВМЕСТЕ С ПОДСВЕТКОЙ. Оставь здесь прежний id брони — и человек,
  // передумавший и не выбравший ничего взамен, отправит форму со старой бронью: экран
  // показывает сетку без выбранного (то есть «время не выбрано»), проверка
  // обязательности видит непустое значение, а сервер подтверждает ещё живой холд и
  // присылает в письме время, от которого отказались.
  function drop() {
    p.onChange('')
    // Отпускать сам холд не нужно: он протухнет сам, а место освободит счёт занятого.
    // Молча держать его до конца анкеты нельзя — человек выбирает другое время, и
    // первое обязано вернуться в оборот само.
    setHeld(null)
    setRefusal('')
    setReload((n) => n + 1)
  }

  const note = zoneNote(p.source.timezone)
  const page = cells?.slice(shown, shown + cols) ?? []
  const day = cells?.find((c) => c.key === activeDay) ?? null
  // picked — время, которое держит ОТВЕТ, а не показ: пустое значение снаружи (сброс
  // формы, очистка условной логикой) обязано гасить подсветку вместе с ответом.
  const picked = p.value !== '' && held ? held : null

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
            onChange={(e) => {
              setSeats(Number(e.currentTarget.value))
              // ⚠ Холд взят НА ПРЕЖНЕЕ ЧИСЛО МЕСТ. Оставь его — и в письме поедет
              // бронь на одно место у того, кто выбрал три.
              if (picked) drop()
            }}
          >
            {Array.from({ length: p.source.maxSeats }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}

      {cells === null && !failed && <p className="rf-slots-note">Загружаем свободное время…</p>}

      {failed && (
        <p className="rf-slots-note" role="alert">
          Не удалось загрузить свободное время.{' '}
          <button type="button" className="rf-slots-link" onClick={() => setReload((n) => n + 1)}>
            Повторить
          </button>
        </p>
      )}

      {cells?.length === 0 && (
        <p className="rf-slots-note">Свободного времени сейчас нет. Загляните позже.</p>
      )}

      {cells && cells.length > 0 && (
        <>
          <section>
            {/* Месяц слева, шевроны справа: сама лента начинается от левого края блока,
                как остальные вопросы формы, и ничем внутрь не сдвинута. */}
            <div className="rf-slots-head">
              <p className="rf-slots-month">{monthLabel(page)}</p>
              <div className="rf-slots-turn">
                <button
                  type="button"
                  className="rf-slots-arrow"
                  aria-label="Предыдущие дни"
                  disabled={shown === 0}
                  onClick={() => turn(-1)}
                >
                  <Chevron back />
                </button>
                <button
                  type="button"
                  className="rf-slots-arrow"
                  aria-label="Следующие дни"
                  disabled={shown >= lastStart(cells.length, cols)}
                  onClick={() => turn(1)}
                >
                  <Chevron />
                </button>
              </div>
            </div>
            <div
              ref={week}
              className="rf-slots-week"
              role="tablist"
              aria-label="Даты"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {page.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  role="tab"
                  aria-selected={c.key === activeDay}
                  disabled={c.slots.length === 0}
                  className={
                    c.key === activeDay ? 'rf-slots-date rf-slots-date--on' : 'rf-slots-date'
                  }
                  onClick={() => selectDay(c.key)}
                >
                  <span className="rf-slots-num">{c.num}</span>
                  <span className="rf-slots-dow">{c.weekday}</span>
                </button>
              ))}
            </div>
          </section>

          {day && (
            <section className="rf-slots-hours">
              <p className="rf-slots-chosen">{fullDayLabel(day)}</p>
              <div className="rf-slots-times" role="group" aria-label="Время">
                {day.slots.map((slot) => {
                  const enough = fits(slot, seats)
                  const on = picked?.startsAt === slot.startsAt
                  return (
                    <button
                      key={slot.startsAt}
                      type="button"
                      // Выбранное время гасить нельзя: повторный клик по нему —
                      // единственный способ передумать, не выбирая ничего взамен.
                      disabled={(!enough && !on) || holding !== ''}
                      aria-pressed={on}
                      className={on ? 'rf-slots-time rf-slots-time--on' : 'rf-slots-time'}
                      onClick={() => (on ? drop() : void pick(slot))}
                    >
                      {timeLabel(slot.startsAt)}
                      {p.source.showRemaining && slot.remaining > 1 && (
                        <span className="rf-slots-left">осталось {slot.remaining}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}

      {picked && (
        <p className="rf-slots-picked">
          Выбрано:{' '}
          {new Date(picked.startsAt).toLocaleString(LOCALE, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit',
          })}
          {seats > 1 && ` · мест: ${seats}`}
        </p>
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

// lastStart — начало последней страницы ленты. Считается от последнего квадрата, а не
// делением длины: при длине, кратной странице, деление дало бы страницу за её концом.
function lastStart(total: number, cols: number): number {
  return Math.floor(Math.max(total - 1, 0) / cols) * cols
}
