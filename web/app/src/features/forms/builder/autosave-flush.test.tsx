// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type StoreApi } from 'zustand/vanilla'

import { SCHEMA_VERSION, textFromString, type FormSchema } from '@entities/formSchema'
import { createBuilderStore, type BuilderStore } from './store'
import { useAutosave } from './useAutosave'

// Уход с полотна раньше дебаунса (TD-42). Автосейв ждёт 800 мс, а «уйти с полотна» —
// не редкий путь, а обычный клик по «Ответы» в шапке: размонтирование обязано
// ДОСЛАТЬ назначенную правку, а не погасить таймер молча. Дыра была найдена аудитом
// 2026-07-26 и закрыта в фазе 15 (флаш в cleanup эффекта useAutosave), но без своего
// сторожа: правка одной строки в useAutosave возвращала бы потерю правок, а красного
// не было бы нигде. Фаза 16 делает окно вероятным — настройки блока правятся в
// попапе, то есть в месте «правлю и кликаю мимо», — поэтому сторож ставится здесь.
//
// Обратная сторона так же важна: уход БЕЗ незавершённой правки не должен слать PATCH.
// Иначе каждый переход по вкладкам формы двигал бы updated_at и бейдж «есть
// неопубликованные изменения» на ровном месте.

const saveDraftSchema = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ saveDraftSchema }))

const T0 = '2026-07-30T10:00:00.000Z'

const QUESTION: FormSchema = {
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Как вас зовут?') },
    { id: 'inp', groupId: 'g1', type: 'short_text' },
  ],
}

function Probe({ store }: { store: StoreApi<BuilderStore> }) {
  useAutosave(store, 'form-1', 'slug-1', T0)
  return null
}

function setup() {
  const store = createBuilderStore()
  store.getState().hydrate(QUESTION)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <Probe store={store} />
    </QueryClientProvider>,
  )
  return { store, ...view }
}

beforeEach(() => {
  saveDraftSchema.mockReset()
  saveDraftSchema.mockResolvedValue({ updatedAt: '2026-07-30T10:00:01.000Z' })
  // Таймеры фальшивые и НИ РАЗУ не прокручиваются: тест проверяет ровно окно «правка
  // сделана, дебаунс ещё не истёк». Настоящие таймеры дали бы тот же результат, но
  // зависящий от того, успеет ли машина за 800 мс, — то есть флейк на CI.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('автосейв схемы на уходе с полотна (TD-42)', () => {
  it('досылает правку, сделанную раньше дебаунса', async () => {
    const { store, unmount } = setup()

    act(() => {
      store.getState().updateBlock('inp', { required: true })
    })
    expect(saveDraftSchema).not.toHaveBeenCalled()

    unmount()

    expect(saveDraftSchema).toHaveBeenCalledTimes(1)
    const sent = saveDraftSchema.mock.calls[0]![1] as FormSchema
    expect(sent.blocks.find((b) => b.id === 'inp')?.required).toBe(true)
  })

  it('без незавершённой правки уход ничего не отправляет', () => {
    const { unmount } = setup()

    unmount()

    expect(saveDraftSchema).not.toHaveBeenCalled()
  })
})
