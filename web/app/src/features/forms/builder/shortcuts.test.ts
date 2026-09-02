import { describe, expect, it } from 'vitest'
import { MAX_COLUMNS } from '@entities/formSchema'
import {
  arrowDir,
  BLOCK_COMMON,
  chords,
  commonFor,
  formatLabel,
  GLOBAL,
  labelFor,
  SHORTCUTS,
  shortcutsFor,
  type KeyLike,
  type ShortcutContext,
} from './shortcuts'
import type { RowPosition } from './store'

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

  // Alt+J — шторка помощи ИИ. Голая Alt-комбинация: она не должна ловить ни
  // Mod+Alt+J (там половина комбинаций принадлежит окну), ни Alt+Shift+J.
  it('Alt+J открывает помощь ИИ и не путается с соседями', () => {
    expect(chords.openChat(key({ code: 'KeyJ', altKey: true }))).toBe(true)
    expect(chords.openChat(key({ code: 'KeyJ' }))).toBe(false)
    expect(chords.openChat(key({ code: 'KeyJ', altKey: true, shiftKey: true }))).toBe(false)
    expect(chords.openChat(key({ code: 'KeyJ', altKey: true, metaKey: true }))).toBe(false)
    expect(chords.openChat(key({ code: 'KeyJ', altKey: true, ctrlKey: true }))).toBe(false)
    // Ярлык на кнопке берётся из карты — вторая копия строки разошлась бы с ней.
    expect(labelFor(chords.openChat)).toBe('Alt+J')
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

  it('Enter и Shift+Enter в тексте — разные пункты и непересекающиеся матчеры', () => {
    // Жест «Shift+Enter — новый блок внутрь вопроса» снят 2026-08-22: у клавиши
    // текстовое поведение (перенос строки), и карта обязана обещать именно его.
    const enter = SHORTCUTS.text.find((s) => s.label === 'Enter')
    const brk = SHORTCUTS.text.find((s) => s.label === 'Shift+Enter')
    expect(brk?.hint).toBe('Перенос строки внутри блока')
    expect(brk!.match!(key({ code: 'Enter', shiftKey: true }))).toBe(true)
    expect(brk!.match!(key({ code: 'Enter' }))).toBe(false)
    // Обратная половина — та, из-за которой жест и снимался: голый матчер Enter
    // забирал бы Shift+Enter себе, и перенос никогда не доехал бы до текста.
    expect(enter!.match!(key({ code: 'Enter' }))).toBe(true)
    expect(enter!.match!(key({ code: 'Enter', shiftKey: true }))).toBe(false)
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
    // На заголовке формы не работают ни меню действий, ни удаление блока — блочного
    // яруса там нет. А документ-уровень (Mod+Z / Mod+Shift+Z) с фазы 15 работает и
    // на нём: заголовок стал блоком документа и откатывается общей историей, поэтому
    // GLOBAL приезжает целиком. Прятать клавишу, которая работает, значит врать
    // подсказкой — это баг, а не косметика (13.5).
    expect(commonFor('title')).toEqual(GLOBAL)
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
    // Остался ОДИН случай: подпись собранного вопроса несёт групповую ручку, и жест
    // двигает вопрос целиком. Пункт «Переместить блок» оттуда выпадает, перенос
    // вопроса остаётся обещан отдельным Alt+Shift+↑↓. Второй случай (строка ответа,
    // где жест не делал ничего) снят фазой 15 — см. тест ниже.
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

  it('строке ответа перенос обещан на всех её поверхностях (фаза 15)', () => {
    // Замок «у строки ответа в озаглавленной группе нет своего Alt+↑↓» снят (§4.1
    // спеки): жест уносит поле из вопроса и возвращает обратно. Обещан он должен быть
    // ВЕЗДЕ, где эта строка бывает под кареткой: объектная остановка (date/scale),
    // картинка и инпут плейсхолдера — последний до фазы его не знал вовсе.
    for (const ctx of ['object', 'image', 'field'] as const) {
      expect(
        shortcutsFor(ctx).map((s) => s.label),
        ctx,
      ).toContain('Alt+↑↓')
    }
  })

  it('Mod+Alt+→ внутри вопроса обещает СВОЙ заголовок, а не предыдущий вопрос', () => {
    // Клавиша одна, уровень задаёт место строки в группе (фаза 15, §6.6): на голове
    // группы ряд собирается с предыдущим вопросом, на любой другой строке — со своей
    // подписью. Подпись пункта обязана следовать за действием, иначе карта врёт
    // (демо-критерий 13.5).
    for (const ctx of ['field', 'object'] as const) {
      const head = shortcutsFor(ctx).find((s) => s.label === 'Mod+Alt+→')
      const inner = shortcutsFor(ctx, { insideQuestion: true }).find((s) => s.label === 'Mod+Alt+→')
      expect(head?.hint, ctx).toBe('В ряд с предыдущим вопросом')
      expect(inner?.hint, ctx).toBe('В ряд со своим заголовком')
      // Ничего, кроме этой подписи, флаг не трогает: состав списка тот же.
      expect(shortcutsFor(ctx, { insideQuestion: true }).map((s) => s.label)).toEqual(
        shortcutsFor(ctx).map((s) => s.label),
      )
    }
  })

  it('Mod+Alt+←/→ называют шаг оси, а на краю оси в карте не появляются', () => {
    // Ось колонок (этап 15.6, §11.6): одна клавиша значит на разных строках разное, и
    // подпись обязана следовать за действием. Позиция считается тем же rowPosition,
    // которым стор ведёт саму ось, — расхождение карты с поведением проект держит за баг
    // (демо-критерий 13.5).
    const hint = (row: RowPosition, keys: 'Mod+Alt+→' | 'Mod+Alt+←') =>
      shortcutsFor('field', { row }).find((s) => s.label === keys)?.hint

    const inRow = (col: number, cols: number, alone: boolean): RowPosition => ({
      kind: 'in',
      col,
      cols,
      alone,
    })

    // Первый вопрос полотна: в ряд не с кем, из ряда некуда — обоих пунктов нет.
    expect(hint({ kind: 'solo' }, 'Mod+Alt+→')).toBeUndefined()
    expect(hint({ kind: 'solo' }, 'Mod+Alt+←')).toBeUndefined()

    // Из полной ширины работают ОБЕ клавиши: цель одна (предыдущий вопрос), край
    // выбирает направление.
    expect(hint({ kind: 'enter' }, 'Mod+Alt+→')).toBe('В ряд с предыдущим вопросом')
    expect(hint({ kind: 'enter' }, 'Mod+Alt+←')).toBe('В первую колонку ряда')

    // Первая колонка ряда из двух: вправо — переезд во вторую, влево — выход.
    expect(hint(inRow(1, 2, false), 'Mod+Alt+→')).toBe('В 2-ю колонку ряда')
    expect(hint(inRow(1, 2, false), 'Mod+Alt+←')).toBe('Вернуть своим рядом')

    // Последняя колонка: шаг вправо ОТКРЫВАЕТ следующую, пока элемент в колонке не
    // один (иначе она закрылась бы за спиной) и пока не упёрлись в потолок.
    expect(hint(inRow(2, 2, false), 'Mod+Alt+→')).toBe('Новой колонкой справа')
    expect(hint(inRow(2, 2, true), 'Mod+Alt+→')).toBeUndefined()
    expect(hint(inRow(MAX_COLUMNS, MAX_COLUMNS, false), 'Mod+Alt+→')).toBeUndefined()

    // Влево из середины — переезд в предыдущую колонку; из одиночки в ряду из двух —
    // выход (переезд оставил бы колонку пустой).
    expect(hint(inRow(3, 3, false), 'Mod+Alt+←')).toBe('В 2-ю колонку ряда')
    expect(hint(inRow(2, 2, true), 'Mod+Alt+←')).toBe('Вернуть своим рядом')
    expect(hint(inRow(3, 3, true), 'Mod+Alt+←')).toBe('В 2-ю колонку ряда')

    // Кроме двух пунктов оси, состав списка флаг не трогает.
    expect(shortcutsFor('field', { row: inRow(1, 2, false) }).map((s) => s.label)).toEqual(
      shortcutsFor('field').map((s) => s.label),
    )
  })

  it('позиция вопроса на оси не трогает подсказки СТРОКИ ВАРИАНТА', () => {
    // Найдено ревью: строка варианта объявляет контекст без insideQuestion, поэтому в
    // снимок шпаргалки приезжает позиция её БЛОКА — а Mod+Alt+←/→ на варианте работают на
    // своей оси (ряды вариантов внутри choice). Позиция вопроса о них не говорит ничего, и
    // пункты, которые на варианте работают, из карты исчезать не должны.
    const rows: RowPosition[] = [{ kind: 'solo' }, { kind: 'in', col: 2, cols: 2, alone: true }]
    for (const row of rows) {
      expect(shortcutsFor('option', { row })).toEqual(shortcutsFor('option'))
    }
    expect(shortcutsFor('option').find((s) => s.label === 'Mod+Alt+→')?.hint).toBe(
      'В ряд с предыдущим вариантом',
    )
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
