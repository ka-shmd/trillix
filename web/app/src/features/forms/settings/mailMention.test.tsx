// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { act, cleanup, fireEvent, render } from '@testing-library/react'

import { type Block, type Span, SCHEMA_VERSION, textFromString } from '@entities/formSchema'
import { setCaret } from '../builder/richCaret'
import { newFormDetail } from '../draft'
import { MailLine } from './MailLine'

// Подстановка ответа в БЛАНКЕ ПИСЬМА (docs/design/mentions.md §10). Поверхность та же,
// что на полотне (RichLine), поэтому здесь проверяется только то, чем письмо от полотна
// отличается: состав меню (любой вопрос формы, «Все ответы», без вопроса-файла) и то,
// что в тему «Все ответы» не предлагаются.
//
// Чего этот файл не доказывает и что смотрит человек в браузере: вид чипа в бланке,
// Backspace по нему (это поведение БРАУЗЕРА на contenteditable=false, happy-dom его не
// воспроизводит) и перенос строки по Enter.

afterEach(cleanup)

const line = () => document.querySelector('[data-rich-line]') as HTMLElement
const menuItems = () =>
  [...document.querySelectorAll('[role="listbox"] [data-index]')].map((el) => el.textContent)

const blocks: Block[] = [
  { id: 'cap1', groupId: 'g1', type: 'title', text: textFromString('Имя') },
  { id: 'q1', groupId: 'g1', type: 'short_text' },
  { id: 'cap2', groupId: 'g2', type: 'title', text: textFromString('Резюме') },
  { id: 'q2', groupId: 'g2', type: 'file' },
  { id: 'cap3', groupId: 'g3', type: 'title', text: textFromString('Телефон') },
  { id: 'q3', groupId: 'g3', type: 'phone' },
]

function blank(multiline: boolean, editable = true) {
  const onChange = vi.fn<(v: Span[]) => void>()
  const form = { ...newFormDetail(), draftSchema: { schemaVersion: SCHEMA_VERSION, blocks } }
  render(
    <MailLine
      form={form}
      value={[]}
      onChange={onChange}
      label="Текст письма"
      multiline={multiline}
      editable={editable}
    />,
  )
  return onChange
}

// Посимвольный набор, как в mentionCanvas.test.tsx: триггер «@» срабатывает, только
// когда символ стоит прямо перед кареткой.
function typeRich(value: string) {
  const el = line()
  let cur = el.textContent ?? ''
  for (const ch of value.slice(cur.length)) {
    el.appendChild(el.ownerDocument.createTextNode(ch))
    cur += ch
    setCaret(el, cur.length)
    fireEvent.input(el)
  }
}

describe('«@» в бланке письма', () => {
  it('в тексте предлагает «Все ответы» и любой вопрос формы, кроме файла', () => {
    blank(true)
    line().focus()
    typeRich('@')
    // Правила «источник выше носителя» здесь нет: письмо пишется по ГОТОВОМУ ответу, и
    // «ниже» в нём ничего не значит. Вопрос-файл не предлагается (answer-files.md §9).
    expect(menuItems()).toEqual(['Все ответы', 'Имя', 'Телефон'])
  })

  it('в теме «Все ответы» не предлагаются: тема — одна строка', () => {
    blank(false)
    line().focus()
    typeRich('@')
    expect(menuItems()).toEqual(['Имя', 'Телефон'])
  })

  it('выбор ставит чип: имя вопроса в тексте, id источника в ref', () => {
    const onChange = blank(true)
    line().focus()
    typeRich('@')
    act(() => {
      fireEvent.keyDown(line(), { code: 'Enter' })
    })
    // Первый пункт меню в тексте письма — «Все ответы», и ссылается он на служебный
    // источник, а не на блок.
    expect(onChange).toHaveBeenLastCalledWith([{ t: 'Все ответы', ref: '_all' }, { t: ' ' }])
  })

  it('на бесплатном тарифе бланк не принимает ни набора, ни фокуса', () => {
    blank(true, false)
    expect(line().getAttribute('contenteditable')).toBe('false')
    expect(line().tabIndex).toBe(-1)
    line().focus()
    typeRich('@')
    expect(menuItems()).toEqual([])
  })
})
