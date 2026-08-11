// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import type { ReactNode } from 'react'

import { SCHEMA_VERSION, type FormSchema, textFromString } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine } from './focusEngine'
import { useCaptionGuard } from './captionGuard'

// Цена свободы строки ответа названа вслух (§4.3 спеки фазы 15): правка, оставившая
// живое поле без заголовка, не запрещается, а показывается тостом с отменой. Что
// именно считается потерей, проверяет store.test (captionLoss) — здесь проверяется
// связка: обёртка зовёт команду, узнаёт вопрос-жертву и умеет откатить.

vi.mock('sonner', () => ({ toast: vi.fn() }))

afterEach(cleanup)
beforeEach(() => vi.mocked(toast).mockClear())

// Вопрос «Имя» (подпись + поле) и абзац под ним.
const QUESTION: FormSchema = {
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Имя') },
    { id: 'inp', groupId: 'g1', type: 'short_text', settings: {} },
    { id: 'para', groupId: 'g2', type: 'text', text: textFromString('Абзац') },
  ],
}

function setup(schema: FormSchema = QUESTION) {
  const store = createBuilderStore()
  store.getState().hydrate(schema)
  const engine = createFocusEngine()
  const focusBlock = vi.spyOn(engine, 'focusBlock')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BuilderStoreContext.Provider value={store}>{children}</BuilderStoreContext.Provider>
  )
  const { result } = renderHook(() => useCaptionGuard(engine), { wrapper })
  return { store, focusBlock, guard: (run: () => void) => act(() => result.current(run)) }
}

// Опции последнего тоста — второй аргумент вызова.
const lastToastOptions = () => vi.mocked(toast).mock.calls.at(-1)?.[1] as
  | { action?: { label: string; onClick: () => void } }
  | undefined

describe('captionGuard', () => {
  it('перенос поля из вопроса называет жертву тостом', () => {
    const { guard, store } = setup()

    guard(() => store.getState().moveBlock('inp', 'up')) // поле уехало выше подписи

    expect(toast).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast).mock.calls[0]![0]).toBe('Вопрос «Имя» остался без заголовка')
  })

  it('кнопка отмены возвращает документ и ставит каретку, как Mod+Z', () => {
    const { guard, store, focusBlock } = setup()
    const before = store.getState().blocks.map((b) => b.id)

    guard(() => store.getState().moveBlock('inp', 'up'))
    act(() => lastToastOptions()!.action!.onClick())

    expect(store.getState().blocks.map((b) => b.id)).toEqual(before)
    // Каретка — на первый затронутый откатом блок (§2.4): им оказывается подпись,
    // вернувшаяся на нулевую позицию. Id даёт сам стор — кнопка тоста и Mod+Z зовут
    // одну и ту же команду.
    expect(focusBlock).toHaveBeenCalledWith('cap')
  })

  it('после других правок кнопка отмены не откатывает чужой шаг', () => {
    const { guard, store } = setup()

    guard(() => store.getState().moveBlock('inp', 'up'))
    // Автор успел поправить документ, пока тост висел: его шаг больше не вершина
    // истории, и undo снял бы именно эту правку — заголовка это не вернёт.
    store.getState().updateBlock('inp', { settings: { placeholder: 'Иванов' } })
    const afterEdit = store.getState().blocks

    act(() => lastToastOptions()!.action!.onClick())

    expect(store.getState().blocks).toBe(afterEdit)
    expect(vi.mocked(toast).mock.calls.at(-1)?.[0]).toBe(
      'После этой правки были другие — отменяйте их по очереди (Ctrl+Z)',
    )
  })

  it('правка, никого не оставившая без заголовка, молчит', () => {
    const { guard, store } = setup()

    guard(() => store.getState().moveGroup('cap', 'down')) // вопрос переехал целиком

    expect(toast).not.toHaveBeenCalled()
  })

  it('нескольких жертв называет одним тостом, а не очередью', () => {
    const { guard, store } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'c1', groupId: 'g1', type: 'title', text: textFromString('Имя') },
        { id: 'f1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 'c2', groupId: 'g2', type: 'title', text: textFromString('Почта') },
        { id: 'f2', groupId: 'g2', type: 'email', settings: {} },
        { id: 'lone', groupId: 'g3', type: 'date', settings: {} },
      ],
    })

    // Голое поле встаёт между вторым заголовком и его полем: заголовок «Почта»
    // достаётся пришельцу, f2 остаётся голым. Заодно уносим f1 из его вопроса.
    guard(() => {
      store.getState().reorderBlocks('lone', 'c2')
      store.getState().moveBlock('f1', 'up')
    })

    expect(toast).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast).mock.calls[0]![0]).toBe('Несколько вопросов остались без заголовка')
  })
})
