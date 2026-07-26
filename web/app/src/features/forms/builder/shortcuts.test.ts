import { describe, expect, it } from 'vitest'
import {
  arrowDir,
  BLOCK_COMMON,
  chords,
  commonFor,
  formatLabel,
  GLOBAL,
  SHORTCUTS,
  shortcutsFor,
  type KeyLike,
  type ShortcutContext,
} from './shortcuts'

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
  it('каждый контекст непустой, у каждого пункта есть подпись и описание', () => {
    for (const [ctx, list] of Object.entries(SHORTCUTS)) {
      expect(list.length, ctx).toBeGreaterThan(0)
      for (const s of list) {
        expect(s.label.length, `${ctx}:${s.hint}`).toBeGreaterThan(0)
        expect(s.hint.length, `${ctx}:${s.label}`).toBeGreaterThan(0)
        // match необязателен только у символьных жестов («/», «любой символ», «⌫ в
        // пустом»): их ловят по произведённому символу/состоянию, а не по e.code.
        if (s.match !== undefined) expect(typeof s.match, `${ctx}:${s.label}`).toBe('function')
      }
    }
  })

  it('Shift+Enter в тексте — отдельная строка карты, матчится только с Shift', () => {
    const inside = SHORTCUTS.text.find((s) => s.label === 'Shift+Enter')
    expect(inside).toBeDefined()
    expect(inside!.match!(key({ code: 'Enter', shiftKey: true }))).toBe(true)
    expect(inside!.match!(key({ code: 'Enter' }))).toBe(false)
  })
})

describe('ярусы карты — общее вынесено из контекстов (§7)', () => {
  const contexts = Object.keys(SHORTCUTS) as ShortcutContext[]

  it('ни один контекстный пункт не повторяет общий ярус', () => {
    // Смысл разделения: у сфокусированной строки видно только специфичное, общее
    // живёт в шпаргалке. Дубль в контексте вернул бы «Cmd+.» во все чипы разом.
    const commonLabels = new Set([...BLOCK_COMMON, ...GLOBAL].map((s) => s.label))
    for (const ctx of contexts) {
      for (const s of SHORTCUTS[ctx]) {
        expect(commonLabels.has(s.label), `${ctx}:${s.label}`).toBe(false)
      }
    }
  })

  it('внутри контекста подписи клавиш не дублируются', () => {
    for (const ctx of contexts) {
      const labels = SHORTCUTS[ctx].map((s) => s.label)
      expect(new Set(labels).size, ctx).toBe(labels.length)
    }
  })

  it('общий ярус блочных строк не приезжает на заголовок формы и пустое полотно', () => {
    // На названии формы не работают ни меню действий, ни удаление блока, а undo там
    // нативный (data-undo-native) — из общего остаётся только сама шпаргалка.
    expect(commonFor('title').map((s) => s.label)).toEqual(['Mod+/'])
    // Пустое полотно — не строка блока: Cmd+. и Cmd+Shift+⌫ там некому обработать.
    expect(commonFor('canvas')).toEqual(GLOBAL)
    expect(commonFor('text')).toEqual([...BLOCK_COMMON, ...GLOBAL])
  })

  it('Mod+Enter показывается текстовой строке только при отвечаемом блоке в группе', () => {
    // handleAnswerAction молчит, когда в группе нет контрола ответа (одиночный абзац):
    // подсказка обязана исчезать вместе с действием — демо-критерий этапа.
    const withAnswer = shortcutsFor('text', { hasAnswer: true }).map((s) => s.label)
    const alone = shortcutsFor('text').map((s) => s.label)
    expect(withAnswer).toContain('Mod+Enter')
    expect(alone).not.toContain('Mod+Enter')
    // Остальные пункты контекста от флага не зависят.
    expect(alone).toEqual(withAnswer.filter((l) => l !== 'Mod+Enter'))
  })

  it('перенос строки не обещан там, где Alt+↑↓ двигает не строку', () => {
    // Два случая (решение владельца 2026-07-26): на строке ответа в озаглавленной
    // группе жест не делает ничего, на подписи вопроса — двигает вопрос целиком.
    // Пункт «Переместить блок» выпадает в обоих; перенос вопроса остаётся обещан.
    const moved = shortcutsFor('object').map((s) => s.label)
    const still = shortcutsFor('object', { movesRow: false }).map((s) => s.label)
    expect(moved).toContain('Alt+↑↓')
    expect(still).not.toContain('Alt+↑↓')
    expect(still).toContain('Alt+Shift+↑↓')
    expect(still).toEqual(moved.filter((l) => l !== 'Alt+↑↓'))

    const caption = shortcutsFor('text', { hasAnswer: true, movesRow: false }).map((s) => s.label)
    expect(caption).not.toContain('Alt+↑↓')
    expect(caption).toContain('Alt+Shift+↑↓')
  })

  it('картинка и date/scale — разные контексты: файловый диалог обещан только картинке', () => {
    // На date/scale Cmd+Enter ищет input[type=file] внутри остановки и не находит.
    expect(shortcutsFor('image').map((s) => s.label)).toContain('Mod+Enter')
    expect(shortcutsFor('object').map((s) => s.label)).not.toContain('Mod+Enter')
  })

  it('символьные жесты объектной остановки различены: «/» и печатный символ', () => {
    // ObjectStop.onKeyDown обрабатывает «/» ОТДЕЛЬНО от печатного символа: «/» ставит
    // строку ниже с открытым меню типов, любой другой символ засевает ею текст. Один
    // пункт «любой символ» на оба обещал бы за «/» неправду.
    for (const ctx of ['image', 'object'] as const) {
      const labels = SHORTCUTS[ctx].map((s) => s.label)
      expect(labels, ctx).toContain('/')
      expect(labels, ctx).toContain('любой символ')
    }
  })

  it('Mod+Enter в варианте показан: обработчик списка ловит его как Enter', () => {
    // chords.enter матчит и Cmd+Enter (code 'Enter'), и OptionsInline не исключает
    // модификатор — клавиша работает, значит обязана быть в карте.
    expect(SHORTCUTS.option.map((s) => s.label)).toContain('Mod+Enter')
  })

  it('formatLabel подставляет модификатор машины вместо токена Mod', () => {
    // В node-окружении (без navigator) это Ctrl; на маке — ⌘. Токен наружу не течёт.
    expect(formatLabel('Mod+Shift+⌫')).toBe('Ctrl+Shift+⌫')
    expect(formatLabel('Alt+↑↓')).toBe('Alt+↑↓')
  })
})
