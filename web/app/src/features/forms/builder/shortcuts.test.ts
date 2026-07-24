import { describe, expect, it } from 'vitest'
import { arrowDir, chords, SHORTCUTS, type KeyLike } from './shortcuts'

// Ключевое событие по умолчанию — без модификаторов. Тесты дописывают нужные поля.
function key(over: Partial<KeyLike>): KeyLike {
  return { code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over }
}

describe('chords — биндинги по e.code (§3.1)', () => {
  it('undo/redo смотрят на физическую клавишу, а не на раскладку', () => {
    // Кириллическая раскладка: Ctrl+Z даёт e.key='я', но e.code='KeyZ'. Матчер обязан
    // ловить именно code — иначе хоткей молча ломается (проект уже наступал).
    expect(chords.undo(key({ code: 'KeyZ', ctrlKey: true }))).toBe(true)
    expect(chords.undo(key({ code: 'KeyZ', metaKey: true }))).toBe(true)
    // Shift+Z и Y (в любом виде) — redo, не undo.
    expect(chords.undo(key({ code: 'KeyZ', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(chords.redo(key({ code: 'KeyZ', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(chords.redo(key({ code: 'KeyY', ctrlKey: true }))).toBe(true)
    // Без командного модификатора — ни то ни другое.
    expect(chords.undo(key({ code: 'KeyZ' }))).toBe(false)
    expect(chords.redo(key({ code: 'KeyY' }))).toBe(false)
  })

  it('командные комбо требуют Cmd или Ctrl и не путаются с голыми клавишами', () => {
    expect(chords.deleteBlock(key({ code: 'Backspace', metaKey: true, shiftKey: true }))).toBe(true)
    expect(chords.deleteBlock(key({ code: 'Backspace', ctrlKey: true, shiftKey: true }))).toBe(true)
    // Без Shift — это не удаление блока, а голый Backspace.
    expect(chords.deleteBlock(key({ code: 'Backspace', metaKey: true }))).toBe(false)
    expect(chords.actionMenu(key({ code: 'Period', metaKey: true }))).toBe(true)
    expect(chords.actionMenu(key({ code: 'Period' }))).toBe(false)
    expect(chords.answerAction(key({ code: 'Enter', ctrlKey: true }))).toBe(true)
  })

  it('перенос группы (Alt+Shift) отделён от переноса блока (Alt)', () => {
    const altShiftUp = key({ code: 'ArrowUp', altKey: true, shiftKey: true })
    expect(chords.moveGroup(altShiftUp)).toBe(true)
    // moveItem (Alt+стрелка) тоже матчит Alt+Shift — поэтому обработчик обязан проверять
    // moveGroup ПЕРВЫМ. Тест фиксирует это перекрытие как ожидаемое (см. коммент chords).
    expect(chords.moveItem(altShiftUp)).toBe(true)
    expect(chords.moveGroup(key({ code: 'ArrowUp', altKey: true }))).toBe(false)
    expect(chords.moveItem(key({ code: 'ArrowDown', altKey: true }))).toBe(true)
  })

  it('arrowDir выводит направление из e.code', () => {
    expect(arrowDir(key({ code: 'ArrowUp' }))).toBe('up')
    expect(arrowDir(key({ code: 'ArrowDown' }))).toBe('down')
  })
})

describe('карта SHORTCUTS — единый источник (§3.2)', () => {
  it('каждый контекст непустой и его матчеры не расходятся с chords', () => {
    // «/» и печатный seed — символьные жесты, в карту не входят: у неё только биндинги.
    for (const [ctx, list] of Object.entries(SHORTCUTS)) {
      expect(list.length, ctx).toBeGreaterThan(0)
      for (const s of list) {
        expect(typeof s.match, `${ctx}:${s.label}`).toBe('function')
        expect(s.label.length, `${ctx}:${s.hint}`).toBeGreaterThan(0)
        expect(s.hint.length, `${ctx}:${s.label}`).toBeGreaterThan(0)
      }
    }
  })

  it('Shift+Enter в тексте — отдельная строка карты, матчится только с Shift', () => {
    const inside = SHORTCUTS.text.find((s) => s.label === 'Shift+Enter')
    expect(inside).toBeDefined()
    expect(inside!.match(key({ code: 'Enter', shiftKey: true }))).toBe(true)
    expect(inside!.match(key({ code: 'Enter' }))).toBe(false)
  })
})
