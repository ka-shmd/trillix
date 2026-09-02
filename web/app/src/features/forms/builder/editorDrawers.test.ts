// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import { useEditorDrawers } from './editorDrawers'

// Две шторки редактора делят одно место у правого края и один отступ оболочки
// (`--app-drawer`). Открытые вместе они лягут друг на друга, а закрытие первой снимет
// отступ из-под второй — шапка и полотно поедут назад под открытую панель.
//
// Правило проверяется у ХУКА, а не у экрана: пока оно жило обёртками рядом с двумя
// useState, кнопка «Оформление» звала сеттер мимо них (ревью 2026-09-02), и никакой
// тест этого не ловил, потому что ловить было нечего — правило не было местом.
describe('шторки редактора', () => {
  it('открытие одной закрывает другую', () => {
    const { result } = renderHook(() => useEditorDrawers())

    act(() => result.current.openChat(true))
    expect([result.current.chatOpen, result.current.designOpen]).toEqual([true, false])

    act(() => result.current.openDesign(true))
    expect([result.current.chatOpen, result.current.designOpen]).toEqual([false, true])

    act(() => result.current.openChat(true))
    expect([result.current.chatOpen, result.current.designOpen]).toEqual([true, false])
  })

  // Radix зовёт onOpenChange(false) и у закрытой шторки (Esc, размонтирование), и
  // такой вызов не должен захлопывать соседку.
  it('закрытие закрывает только себя', () => {
    const { result } = renderHook(() => useEditorDrawers())

    act(() => result.current.openChat(true))
    act(() => result.current.openDesign(false))
    expect(result.current.chatOpen).toBe(true)

    act(() => result.current.openChat(false))
    expect([result.current.chatOpen, result.current.designOpen]).toEqual([false, false])
  })
})
