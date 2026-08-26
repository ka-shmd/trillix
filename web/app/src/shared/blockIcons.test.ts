import { describe, expect, it } from 'vitest'
import { BLOCK_TYPES } from '@entities/blocks/contract'

import { BLOCK_ICONS } from './blockIcons'

describe('глифы типов', () => {
  it('глиф у каждого типа свой', () => {
    // Глиф — единственная опора автора там, где типы стоят рядом (slash-меню, диалог
    // добавления, смена типа в попапе), где подписи нет вовсе (правый угол поля на
    // полотне) и где имена типов совпадают (список вопросов в условной логике, шапка
    // колонки в таблице ответов). Два типа с одной иконкой в этих местах неразличимы.
    const seen = new Map<unknown, string>()
    for (const t of BLOCK_TYPES) {
      const twin = seen.get(BLOCK_ICONS[t])
      expect(twin, `${t} и ${twin} делят один глиф`).toBeUndefined()
      seen.set(BLOCK_ICONS[t], t)
    }
  })
})
