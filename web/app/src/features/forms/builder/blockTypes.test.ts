import { describe, expect, it } from 'vitest'

import { BLOCK_TYPES } from '@entities/blocks/contract'

import { MENU_ITEMS, filterMenuItems } from './blockTypes'
import { editorKind } from './kinds/index'

// Меню вставки выводится из реестра типов, и с 2026-08-21 у типа может быть НЕ ОДИН пункт:
// вариант (KindVariant) — тот же блок с другими дефолтами. Сторож нужен, потому что
// расхождение молчаливое: забытый вариант просто не появится в меню, ничего не сломав.

describe('MENU_ITEMS', () => {
  it('ключи уникальны — на них стоит плоский индекс клавиатурной навигации', () => {
    const keys = MENU_ITEMS.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('вариант стоит сразу за своим базовым пунктом', () => {
    for (const type of BLOCK_TYPES) {
      const variants = editorKind(type).variants ?? []
      if (variants.length === 0) continue
      const base = MENU_ITEMS.findIndex((i) => i.type === type && i.preset === undefined)
      expect(base, `базового пункта типа ${type} нет в меню`).toBeGreaterThanOrEqual(0)
      expect(MENU_ITEMS[base + 1]?.label).toBe(variants[0]!.label)
    }
  })

  it('у базового пункта пресета нет, у варианта он свой', () => {
    const page = MENU_ITEMS.filter((i) => i.type === 'page_break')
    expect(page.map((i) => i.label)).toEqual(['Новая страница', 'Страница «Спасибо»'])
    expect(page[0]!.preset).toBeUndefined()
    expect(page[1]!.preset).toEqual({ settings: { thankYou: true } })
  })

  // Иконка приезжает ПУНКТОМ: у варианта она своя, и с иконкой типа он был бы в списке
  // неотличим от базового пункта.
  it('у варианта своя иконка', () => {
    const page = MENU_ITEMS.filter((i) => i.type === 'page_break')
    expect(page[1]!.icon).not.toBe(page[0]!.icon)
  })

  it('вариант находится поиском по своему названию, а не по названию типа', () => {
    expect(filterMenuItems('спасибо').map((i) => i.label)).toEqual(['Страница «Спасибо»'])
    expect(filterMenuItems('новая страница').map((i) => i.label)).toEqual(['Новая страница'])
  })
})
