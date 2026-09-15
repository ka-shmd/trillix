// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'

import { createFocusEngine, type FocusTarget } from './focusEngine'
import { textCaret } from './caret'

// Юнит-тесты фокус-движка и адаптера каретки (§2.5–2.6). DOM-окружение —
// happy-dom (докблок выше): нужен настоящий <textarea> с selection и
// document.activeElement, которых нет в node-окружении прочих тестов.

afterEach(() => {
  document.body.replaceChildren()
})

// makeTextarea — реальный <textarea> в документе с заданным текстом и кареткой.
function makeTextarea(value = ''): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  el.value = value
  document.body.appendChild(el)
  return el
}

describe("цель, ответившая 'defer'", () => {
  it('запрос дожидается поверхности, зарегистрированной под тем же id', () => {
    const engine = createFocusEngine()
    const calls: string[] = []
    const off = engine.register('b', {
      focus: () => {
        calls.push('свёрнутый')
        return 'defer'
      },
    })
    engine.focusBlock('b', 'start')
    off()
    engine.register('b', { focus: (edge) => void calls.push(`список:${edge}`) })
    expect(calls).toEqual(['свёрнутый', 'список:start'])
  })
})

describe('textCaret', () => {
  it('focus("start") ставит каретку в начало и фокус на элемент', () => {
    const el = makeTextarea('привет')
    textCaret(el).focus('start')
    expect(document.activeElement).toBe(el)
    expect(el.selectionStart).toBe(0)
    expect(el.selectionEnd).toBe(0)
  })

  it('focus("end") ставит каретку в конец', () => {
    const el = makeTextarea('привет')
    textCaret(el).focus('end')
    expect(el.selectionStart).toBe(6)
    expect(el.selectionEnd).toBe(6)
  })

  it('caretAtStart/caretAtEnd — только при схлопнутой каретке на краю', () => {
    const el = makeTextarea('abc')
    const c = textCaret(el)
    el.setSelectionRange(0, 0)
    expect(c.caretAtStart()).toBe(true)
    expect(c.caretAtEnd()).toBe(false)
    el.setSelectionRange(3, 3)
    expect(c.caretAtStart()).toBe(false)
    expect(c.caretAtEnd()).toBe(true)
    // Выделение (не схлопнута) — ни начало, ни конец.
    el.setSelectionRange(0, 3)
    expect(c.caretAtStart()).toBe(false)
    expect(c.caretAtEnd()).toBe(false)
  })
})

describe('createFocusEngine', () => {
  // probe — цель, запоминающая, с каким краем её сфокусировали.
  function probe(): FocusTarget & { edges: string[] } {
    const edges: string[] = []
    return { edges, focus: (edge) => void edges.push(edge) }
  }

  it('focusBlock фокусирует зарегистрированную строку сразу', () => {
    const engine = createFocusEngine()
    const p = probe()
    engine.register('b1', p)
    engine.focusBlock('b1', 'start')
    expect(p.edges).toEqual(['start'])
  })

  it('edge по умолчанию — end', () => {
    const engine = createFocusEngine()
    const p = probe()
    engine.register('b1', p)
    engine.focusBlock('b1')
    expect(p.edges).toEqual(['end'])
  })

  it('focusBlock до регистрации откладывается и применяется при register', () => {
    const engine = createFocusEngine()
    const p = probe()
    // Строка ещё не смонтировалась — запрос копится.
    engine.focusBlock('b1', 'end')
    expect(p.edges).toEqual([])
    engine.register('b1', p)
    expect(p.edges).toEqual(['end'])
  })

  it('отложенный запрос одноразовый — повторный register при живом фокусе молчит', () => {
    const engine = createFocusEngine()
    engine.focusBlock('b1')
    const el1 = makeTextarea('b1')
    engine.register('b1', { focus: (edge) => textCaret(el1).focus(edge) })
    expect(document.activeElement).toBe(el1)
    // Ремаунт той же строки без нового focusBlock и с живым фокусом молчит
    // (страховка от потери — отдельный кейс ниже: только когда фокус упал в body).
    const p2 = probe()
    engine.register('b1', p2)
    expect(p2.edges).toEqual([])
    expect(document.activeElement).toBe(el1)
  })

  it('focusBlock на неизвестную строку — no-op (не бросает)', () => {
    const engine = createFocusEngine()
    expect(() => engine.focusBlock('нет-такой')).not.toThrow()
  })

  it('ремаунт строки возвращает потерянный фокус (страховка от смены groupId)', () => {
    const engine = createFocusEngine()
    // Фокус поставлен синхронно на старый элемент…
    const el1 = makeTextarea('старый')
    engine.register('b1', { focus: (edge) => textCaret(el1).focus(edge) })
    engine.focusBlock('b1', 'end')
    expect(document.activeElement).toBe(el1)
    // …операция сменила groupId → GroupRow ремаунтится: старый элемент гибнет,
    // фокус падает в body.
    el1.remove()
    expect(document.activeElement === null || document.activeElement === document.body).toBe(true)
    // Новая цель того же id при регистрации возвращает каретку.
    const el2 = makeTextarea('новый')
    engine.register('b1', { focus: (edge) => textCaret(el2).focus(edge) })
    expect(document.activeElement).toBe(el2)
  })

  it('ремаунт НЕ крадёт фокус, если он жив в другом месте', () => {
    const engine = createFocusEngine()
    const el1 = makeTextarea('строка')
    engine.register('b1', { focus: (edge) => textCaret(el1).focus(edge) })
    engine.focusBlock('b1')
    // Пользователь ушёл в другое поле…
    const other = makeTextarea('другое')
    other.focus()
    // …ремаунт b1 не должен вырывать каретку.
    const el2 = makeTextarea('новая b1')
    engine.register('b1', { focus: (edge) => textCaret(el2).focus(edge) })
    expect(document.activeElement).toBe(other)
  })

  it('unregister снимает только свою запись', () => {
    const engine = createFocusEngine()
    const p1 = probe()
    const unregister = engine.register('b1', p1)
    // Ремаунт: новая цель перезаписала запись до того, как старая снялась.
    const p2 = probe()
    engine.register('b1', p2)
    // Снятие старой регистрации не должно выкинуть актуальную p2.
    unregister()
    engine.focusBlock('b1')
    expect(p2.edges).toEqual(['end'])
    expect(p1.edges).toEqual([])
  })
})
