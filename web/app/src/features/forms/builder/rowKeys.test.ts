import { describe, expect, it, vi } from 'vitest'

import { handleRowKeys, type RowKeyEvent, type RowKeySpec } from './rowKeys'

// Контракт поверхности строки (этап 16.6). Проверяется ровно то, ради чего цепочка
// сведена в одно место: ПОРЯДОК проверок и правила пропуска. До этапа порядок был
// устной традицией, которую каждая из четырёх поверхностей выводила заново — и одна
// уже выводила неточно (рукописная заплата `!chords.moveGroup(e)` в плейсхолдере).

const key = (code: string, mods: Partial<RowKeyEvent> = {}): RowKeyEvent & { prevented: number } => {
  const e = {
    code,
    key: code,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    prevented: 0,
    preventDefault() {
      e.prevented++
    },
    ...mods,
  }
  return e as RowKeyEvent & { prevented: number }
}

// Поверхность, объявляющая ВСЁ: по ней видно, какая ветка поймала событие.
function fullSpec() {
  const calls: string[] = []
  const spec: RowKeySpec = {
    actionMenu: () => calls.push('actionMenu'),
    deleteBlock: () => calls.push('deleteBlock'),
    answerAction: () => calls.push('answerAction'),
    moveGroup: (dir) => calls.push(`moveGroup:${dir}`),
    rowShift: (side) => calls.push(`rowShift:${side}`),
    moveItem: (dir) => calls.push(`moveItem:${dir}`),
    arrow: (dir) => calls.push(`arrow:${dir}`),
    enter: () => calls.push('enter'),
    backspace: () => calls.push('backspace'),
    slash: () => calls.push('slash'),
    printable: (k) => calls.push(`printable:${k}`),
  }
  return { calls, spec }
}

describe('порядок аккордов — то, ради чего цепочка одна', () => {
  // Голые матчеры модификаторы не исключают: Mod+Enter подходит и под answerAction, и
  // под enter. Порядок разводит их — и это корректность, а не вкус.
  it('Mod+Enter — действие над ответом, а не Enter', () => {
    const { calls, spec } = fullSpec()
    handleRowKeys(key('Enter', { metaKey: true }), spec)
    expect(calls).toEqual(['answerAction'])
  })

  it('Alt+Shift+↑ — перенос группы, а не строки', () => {
    const { calls, spec } = fullSpec()
    handleRowKeys(key('ArrowUp', { altKey: true, shiftKey: true }), spec)
    expect(calls).toEqual(['moveGroup:up'])
  })

  it('Alt+↑ — перенос строки, а не обход', () => {
    const { calls, spec } = fullSpec()
    handleRowKeys(key('ArrowUp', { altKey: true }), spec)
    expect(calls).toEqual(['moveItem:up'])
  })

  it('Mod+Shift+Backspace — удаление блока, а не Backspace поверхности', () => {
    const { calls, spec } = fullSpec()
    handleRowKeys(key('Backspace', { metaKey: true, shiftKey: true }), spec)
    expect(calls).toEqual(['deleteBlock'])
  })

  it('Mod+Alt+→ — ряд, а не печатный символ и не стрелка', () => {
    const { calls, spec } = fullSpec()
    handleRowKeys(key('ArrowRight', { metaKey: true, altKey: true }), spec)
    expect(calls).toEqual(['rowShift:right'])
  })

  // «/» — печатный символ, но у него свой смысл (открыть меню типов), поэтому ветка
  // стоит раньше общей печатной.
  it('«/» идёт в slash, а не в printable', () => {
    const { calls, spec } = fullSpec()
    handleRowKeys(key('Slash', { key: '/' }), spec)
    expect(calls).toEqual(['slash'])
  })
})

describe('пропуск: чего поверхность не объявила, то не её', () => {
  it('необъявленный аккорд не гасится — событие остаётся поверхности', () => {
    const e = key('Enter')
    expect(handleRowKeys(e, {})).toBe(false)
    expect(e.prevented).toBe(0)
  })

  // ГЛАВНОЕ исключение: Alt+Shift+↑↓ не имеет права молча выродиться в «перенести
  // строку». Карта клавиш обещает здесь перенос ГРУППЫ, и поверхность, которая группу
  // двигать не умеет (инпут плейсхолдера), обязана аккорд проглотить, а не подменить.
  it('Alt+Shift+↑ НЕ проваливается в moveItem, если moveGroup не объявлен', () => {
    const moveItem = vi.fn()
    const e = key('ArrowUp', { altKey: true, shiftKey: true })
    expect(handleRowKeys(e, { moveItem })).toBe(false)
    expect(moveItem).not.toHaveBeenCalled()
    expect(e.prevented).toBe(0)
  })

  it('Mod+Enter НЕ проваливается в enter, если answerAction не объявлен', () => {
    const enter = vi.fn()
    expect(handleRowKeys(key('Enter', { metaKey: true }), { enter })).toBe(false)
    expect(enter).not.toHaveBeenCalled()
  })
})

describe('guard-и поверхности', () => {
  // У текста и плейсхолдера стрелка уходит на соседнюю строку только с края каретки —
  // иначе вертикаль внутри длинного текста перестала бы работать.
  it('arrowLeaves=false оставляет стрелку поверхности', () => {
    const arrow = vi.fn()
    const e = key('ArrowDown')
    expect(handleRowKeys(e, { arrow, arrowLeaves: () => false })).toBe(false)
    expect(arrow).not.toHaveBeenCalled()
    expect(e.prevented).toBe(0)
  })

  it('arrowLeaves=true отдаёт стрелку строке', () => {
    const arrow = vi.fn()
    expect(handleRowKeys(key('ArrowDown'), { arrow, arrowLeaves: () => true })).toBe(true)
    expect(arrow).toHaveBeenCalledWith('down')
  })

  it('backspaceHandles=false оставляет Backspace поверхности', () => {
    const backspace = vi.fn()
    const e = key('Backspace')
    expect(handleRowKeys(e, { backspace, backspaceHandles: () => false })).toBe(false)
    expect(backspace).not.toHaveBeenCalled()
    expect(e.prevented).toBe(0)
  })
})

describe('печатный символ', () => {
  it('одиночный символ засевает строку', () => {
    const printable = vi.fn()
    handleRowKeys(key('KeyA', { key: 'a' }), { printable })
    expect(printable).toHaveBeenCalledWith('a')
  })

  it('символ с командным модификатором семенем не считается', () => {
    const printable = vi.fn()
    expect(handleRowKeys(key('KeyA', { key: 'a', metaKey: true }), { printable })).toBe(false)
    expect(printable).not.toHaveBeenCalled()
  })

  it('служебная клавиша семенем не считается', () => {
    const printable = vi.fn()
    expect(handleRowKeys(key('Escape', { key: 'Escape' }), { printable })).toBe(false)
    expect(printable).not.toHaveBeenCalled()
  })
})
