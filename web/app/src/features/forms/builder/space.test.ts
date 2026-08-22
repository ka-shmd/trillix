import { describe, expect, it } from 'vitest'
import { groupBlocks, packRows } from '@fields/groups'
import { type Block, type BlockType, textFromString } from '@entities/formSchema'

import { rowSpace, rowSpaceBelow, spaceMt } from './space'

// Кто на полотне носит ступень воздуха. Тест написан на дефект 2026-08-22: ступень
// повесили на группу — и на полотне её не стало видно вовсе, потому что у обычной
// вертикальной формы КАЖДЫЙ вопрос сам себе полноширинный ряд, а вопрос в ряду головной
// в своей колонке и своего mt не ставит. Правило проверяется здесь, а не глазами:
// расхождение полотна с превью видно только замером, и заметить его нечем.

const block = (id: string, type: BlockType, column?: 'left' | 'right'): Block => ({
  id,
  groupId: id,
  type,
  text: textFromString('Текст'),
  settings: column ? { column: column === 'left' ? 1 : 2 } : {},
})

const rows = (blocks: Block[]) => packRows(groupBlocks(blocks))

describe('ступень воздуха на полотне', () => {
  it('полноширинный ряд несёт ступень своего единственного вопроса', () => {
    const [h1, h2, plain] = rows([
      block('a', 'heading'),
      block('b', 'heading_2'),
      block('c', 'text'),
    ])
    expect(rowSpace(h1!)).toBe('h1')
    expect(rowSpace(h2!)).toBe('h2')
    expect(rowSpace(plain!)).toBe('base')
  })

  it('вопрос с подписью — ступень вопроса, голое поле — базовая', () => {
    const [withCaption, bare] = rows([
      block('t', 'title'),
      block('f', 'short_text'),
      block('g', 'email'),
    ])
    expect(rowSpace(withCaption!)).toBe('q')
    expect(rowSpace(bare!)).toBe('base')
  })

  it('у секции из двух колонок ступени нет — интервал принадлежит ряду', () => {
    const [section] = rows([block('a', 'heading', 'left'), block('b', 'heading', 'right')])
    expect(section).toHaveLength(2)
    expect(rowSpace(section!)).toBe('base')
  })

  it('разрыв страницы носит свои 48px с обеих сторон', () => {
    const [, brk, after] = rows([
      block('a', 'short_text'),
      block('p', 'page_break'),
      block('h', 'heading'),
    ])
    expect(rowSpace(brk!)).toBe('pb')
    expect(spaceMt('pb')).toBe('mt-[calc(3rem*var(--rf-density))]')
    expect(rowSpaceBelow(brk!)).toBe('mb-[calc(3rem*var(--rf-density))]')
    // Сосед снизу СВОЙ интервал сохраняет и добавляет к этим 48px (решение владельца):
    // заголовок под разрывом остаётся при своих 40px.
    expect(rowSpace(after!)).toBe('h1')
  })

  it('отступ снизу есть только у разрыва', () => {
    const [q, txt] = rows([block('t', 'title'), block('p', 'text')])
    expect(rowSpaceBelow(q!)).toBe('')
    expect(rowSpaceBelow(txt!)).toBe('')
  })

  it('ступень разворачивается в утилиту с тем же числом, что класс fields.css', () => {
    expect(spaceMt('h1')).toBe('mt-[calc(2.5rem*var(--rf-density))]')
    expect(spaceMt('h2')).toBe('mt-[calc(2rem*var(--rf-density))]')
    expect(spaceMt('h3')).toBe('mt-[calc(1.5rem*var(--rf-density))]')
    expect(spaceMt('q')).toBe('mt-[calc(1.5rem*var(--rf-density))]')
    expect(spaceMt('base')).toBe('mt-[calc(0.75rem*var(--rf-density))]')
    expect(spaceMt('pb')).toBe('mt-[calc(3rem*var(--rf-density))]')
  })
})
