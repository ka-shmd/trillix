import { describe, expect, it } from 'vitest'

import { type Block } from '@entities/formSchema'
import { publishBlockers } from './publishGate'

// Условия публикации формы записи — зеркало гейта в forms.Publish. Автор узнаёт о
// них по погашенной кнопке и тултипу на ней (решение владельца 2026-09-04), а не по
// 422 в момент, когда уже считает форму готовой.
//
// РЕГРЕССИЯ (отчёт владельца 2026-09-04): форма записи публиковалась без вопроса о
// почте, и письмо о записи после этого молча не уходило — а с ним не уходила ссылка
// отмены, то есть место стояло занятым до самого приёма.

const slot = { id: 's1', groupId: 'g1', type: 'slot' } as Block
const email = (required: boolean) => ({ id: 'e1', groupId: 'g2', type: 'email', required }) as Block
const text = { id: 'q1', groupId: 'g3', type: 'short_text' } as Block

describe('условия публикации', () => {
  it('форма без записи не блокируется ничем', () => {
    expect(publishBlockers([text], null)).toEqual([])
  })

  it('запись без расписания и без почты — две причины', () => {
    expect(publishBlockers([slot], null).map((b) => b.id)).toEqual(['schedule', 'email'])
  })

  it('расписание выбрано, почты нет — одна причина', () => {
    expect(publishBlockers([slot], 'sch-1').map((b) => b.id)).toEqual(['email'])
  })

  // Необязательный вопрос респондент пропускает, и форма возвращается в то же
  // состояние, ради которого условие написано.
  it('почта необязательная не считается', () => {
    expect(publishBlockers([slot, email(false)], 'sch-1').map((b) => b.id)).toEqual(['email'])
  })

  it('расписание и обязательная почта — публикуем', () => {
    expect(publishBlockers([slot, email(true)], 'sch-1')).toEqual([])
  })

  it('причина названа человеческими словами, а не кодом', () => {
    const [first] = publishBlockers([slot], null)
    expect(first?.text).toContain('расписание')
  })
})
