import { describe, expect, it } from 'vitest'

import { eventClass, type EventProps } from './eventClass'
import { formTone } from './formColor'
import type { Booking, ScheduleBlock } from '../../entities/schedule'

// Имя класса — единственное, чем красится полотно, и собирается оно строкой. Ни
// типы, ни сборка потерянного куска этой строки не видят: класс `sc-ev sc-booking 3`
// компилируется, проходит линт и рисует белую карточку. Поймано отчётом владельца
// 2026-09-05 — «цвет записей не работает, они просто белые».
const at = (props: EventProps) => eventClass({ event: { extendedProps: props } })

const booking = (formId: string) => ({ formId }) as Booking

// TONES — сколько тонов раздаёт formColor. Число живёт там, здесь только сверяется.
const TONES = 8

describe('класс события полотна', () => {
  it('запись несёт тон СВОЕЙ формы', () => {
    const cls = at({ layer: 'booking', booking: booking('f-1') })
    expect(cls).toContain('sc-booking')
    // Не просто «есть число», а именно тот тон, которым та же форма покрашена в
    // списке ближайших: разъедься они — цвет перестал бы отвечать на «чья запись».
    expect(cls).toContain(`sc-tone-${formTone('f-1')}`)
  })

  it('разные формы получают разные классы тона', () => {
    // Пара подобрана так, чтобы тона заведомо расходились.
    const a = at({ layer: 'booking', booking: booking('форма-а') })
    const b = at({ layer: 'booking', booking: booking('форма-б') })
    expect(formTone('форма-а')).not.toBe(formTone('форма-б'))
    expect(a).not.toBe(b)
  })

  // Пару «класс ↔ правило в canvas.css» сторожит check-docs.sh: сам CSS сюда не
  // прочитать — vitest css-импорты не обрабатывает и отдаёт пустую строку, а
  // `node:fs` валит `tsc -b` (типов Node в кабинете нет).
  it('formTone не выходит за набор правил', () => {
    for (const id of ['f-1', 'форма-а', '', 'x'.repeat(64)]) {
      expect(formTone(id)).toBeGreaterThanOrEqual(1)
      expect(formTone(id)).toBeLessThanOrEqual(TONES)
    }
  })

  it('часы приёма отличают правило от исключения', () => {
    const weekly = at({
      layer: 'availability',
      date: '2026-09-15',
      window: { from: '10:00', to: '18:00' },
      source: 'weekly',
    })
    const exception = at({
      layer: 'availability',
      date: '2026-09-15',
      window: { from: '10:00', to: '18:00' },
      source: 'exception',
    })
    expect(weekly).toContain('sc-av-weekly')
    expect(exception).toContain('sc-av-ex')
  })

  it('блокировка — свой слой', () => {
    expect(at({ layer: 'block', block: { id: 'b1' } as ScheduleBlock })).toContain('sc-block')
  })

  // Мираж перетаскивания библиотека рисует сама, и своих свойств у него нет. До
  // правки он проваливался в ветку записи и вылезал синей кляксой во всю колонку.
  it('чужое событие не красится нашими слоями', () => {
    const cls = eventClass({ event: { extendedProps: {} } })
    expect(cls).toContain('sc-ghost')
    expect(cls).not.toContain('sc-booking')
    expect(cls).not.toContain('sc-av')
  })
})
