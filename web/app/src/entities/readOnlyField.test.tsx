// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import type { Block } from '@entities/formSchema'
import { BlockField } from '@fields/BlockField'

// ЧИТАЕМЫЙ РЕЖИМ ПОЛЯ (печатная страница ответа, ADR §10). Проверяется общий код
// @fields, поэтому тест живёт в кабинете: у web/shared своего vitest нет, а у
// рендерера нет DOM-окружения.
//
// Смысл режима один: на бумаге ответ обязан быть виден ЦЕЛИКОМ. Контрол ввода этого
// не обещает — input не переносит строку, textarea не растёт, — и потеря происходит
// молча, поэтому она и проверяется тестом, а не глазами.

afterEach(cleanup)

const block = (type: Block['type'], id = 'b1'): Block => ({ id, groupId: 'g1', type })

describe('читаемый режим поля', () => {
  it('короткий ответ печатается текстом в коробке поля, а не в input', () => {
    render(<BlockField block={block('short_text')} value="Иван Петров" disabled readOnly />)

    expect(document.querySelector('input')).toBeNull()
    const box = document.querySelector('.rf-input.rf-input--static')!
    expect(box.textContent).toBe('Иван Петров')
  })

  it('длинный ответ занимает всю колонку — как настоящая textarea', () => {
    render(<BlockField block={block('long_text')} value={'первая\nвторая'} disabled readOnly />)

    const box = document.querySelector('.rf-input--static')!
    expect(box.classList.contains('rf-input--wide')).toBe(true)
    expect(box.textContent).toBe('первая\nвторая')
  })

  it('вопрос без ответа оставляет пустую коробку, а не исчезает', () => {
    render(<BlockField block={block('email')} disabled readOnly />)

    const box = document.querySelector('.rf-input--static')
    expect(box).not.toBeNull()
    // Неразрывный пробел — он и держит высоту пустой коробки.
    expect(box!.textContent).toBe('\u00A0')
  })

  it('дата печатается по-русски, а не в локали браузера принтера', () => {
    render(<BlockField block={block('date')} value="2026-08-30" disabled readOnly />)

    expect(document.querySelector('.rf-input--static')!.textContent).toBe('30.08.2026')
  })

  it('нераспознанная дата печатается как есть — врать про неё нельзя', () => {
    render(<BlockField block={block('date')} value="вчера" disabled readOnly />)

    expect(document.querySelector('.rf-input--static')!.textContent).toBe('вчера')
  })

  it('без режима поле остаётся контролом ввода со значением', () => {
    render(<BlockField block={block('short_text')} value="Иван" disabled />)

    expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('Иван')
    expect(document.querySelector('.rf-input--static')).toBeNull()
  })

  it('выбор режим игнорирует: отмеченный вариант и так виден', () => {
    const choice: Block = {
      id: 'ch',
      groupId: 'g1',
      type: 'single_choice',
      settings: { options: [{ id: 'o1', label: 'Да' }, { id: 'o2', label: 'Нет' }] },
    }
    render(<BlockField block={choice} value="o2" disabled readOnly />)

    const on = document.querySelectorAll('.rf-option--on')
    expect(on).toHaveLength(1)
    expect(on[0]!.textContent).toContain('Нет')
  })
})
