import { describe, expect, it } from 'vitest'
import { groupBlocks } from '@fields/groups'
import { groupClass, groupSpace, type SpaceStep } from '@fields/space'
import { BLOCK_TYPES } from '@entities/blocks/contract'
import { type Block, type BlockType, textFromString } from '@entities/formSchema'

// space.ts (@fields) — кому какая ступень воздуха положена ПЕРЕД вопросом (решение
// владельца 2026-08-22). Числа ступеней живут в двух местах вида (классы .rf-space-* в
// fields.css и утилиты SPACE_MT на полотне), а здесь проверяется распределение — то
// единственное, что у трёх поверхностей обязано совпадать. Тест живёт рядом с
// groups.test.ts: у web/shared своего vitest нет, прогоняет кабинет.

const block = (id: string, type: BlockType): Block => ({
  id,
  groupId: '',
  type,
  text: textFromString(type === 'short_text' ? '' : 'Текст'),
  settings: {},
})

// Ступень вопроса берётся у раскладчика групп, а не у выдуманного списка: так тест
// говорит про то, что видит поверхность, а не про сигнатуру функции.
const stepsOf = (blocks: Block[]): SpaceStep[] =>
  groupBlocks(blocks.map((b, i) => ({ ...b, groupId: `g${i}` }))).map((g) => groupSpace(g.blocks))

describe('ступень воздуха перед вопросом', () => {
  it('заголовок каждого уровня несёт свою', () => {
    expect(
      stepsOf([
        block('h1', 'heading'),
        block('h2', 'heading_2'),
        block('h3', 'heading_3'),
      ]),
    ).toEqual(['h1', 'h2', 'h3'])
  })

  it('вопрос с подписью — своя, голое поле — базовая', () => {
    const withCaption = groupBlocks([
      { ...block('t', 'title'), groupId: 'g1' },
      { ...block('f', 'short_text'), groupId: 'g1' },
    ])
    expect(withCaption.map((g) => groupSpace(g.blocks))).toEqual(['q'])
    expect(stepsOf([block('f', 'short_text')])).toEqual(['base'])
    // Мелкая подпись открывает вопрос так же, как крупная: они различаются видом.
    expect(stepsOf([block('l', 'label')])).toEqual(['q'])
  })

  it('абзац и картинка идут базовым шагом', () => {
    expect(stepsOf([block('p', 'text'), block('i', 'image')])).toEqual(['base', 'base'])
  })

  it('класс обёртки собирается из ступени, у базовой его нет', () => {
    expect(groupClass([block('h', 'heading')])).toBe('rf-group rf-space-h1')
    expect(groupClass([block('f', 'short_text')])).toBe('rf-group')
    // Разрыв страницы класса не получает: у респондента его нет ни на одной поверхности
    // (splitPages режет по нему форму), правило в fields.css было бы мёртвым.
    expect(groupClass([block('p', 'page_break')])).toBe('rf-group')
  })

  it('ступень объявлена у каждого типа', () => {
    // Исчерпывающий Record держит tsc, но забытый тип может получить ступень «на
    // отвяжись» — здесь видно, что распределение осталось осмысленным: своя ступень
    // есть ровно у заголовков, подписей и разрыва страницы.
    const own = BLOCK_TYPES.filter((t) => groupSpace([block('x', t)]) !== 'base')
    expect([...own].sort()).toEqual([
      'heading',
      'heading_2',
      'heading_3',
      'label',
      'page_break',
      'title',
    ])
  })
})
