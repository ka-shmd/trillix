// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { textFromString } from '@entities/formSchema'

import { GhostRow } from './SlashEditor'

// КОПИЯ ПРИ ПЕРЕТАСКИВАНИИ ОБЯЗАНА ВЫГЛЯДЕТЬ КАК СТРОКА НА ПОЛОТНЕ, а не как поле у
// респондента. Расхождение молчит: копия рисуется только во время жеста, тестов у
// жеста нет (dnd-kit в happy-dom не тащит), и заметил его владелец глазами — у записи
// на время копия была вчетверо ниже оригинала.
//
// Проверяется РАЗВИЛКА, а не разметка: объектная строка берёт контрол из реестра
// редактора, остальные — общий BlockField. Разметку каждого контрола держат его
// собственные тесты и общий CSS.

afterEach(cleanup)

describe('гост строки при перетаскивании', () => {
  it('объектная строка рисуется контролом полотна, а не полем респондента', () => {
    const { container } = render(
      <GhostRow
        block={{ id: 's', groupId: 'g1', type: 'slot' }}
        formId="f"
      />,
    )
    // Лента дат — то, что видно на полотне (SlotStub). У выключенного контрола
    // респондента на её месте плашка с выбранным временем.
    expect(container.querySelector('.rf-slots-week')).not.toBeNull()
  })

  it('текстовая строка остаётся на общем BlockField', () => {
    const { container } = render(
      <GhostRow
        block={{ id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') }}
        formId="f"
      />,
    )
    expect(container.querySelector('.rf-label')?.textContent).toBe('Вопрос')
  })
})
