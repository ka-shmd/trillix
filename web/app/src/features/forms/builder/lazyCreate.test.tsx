// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type StoreApi } from 'zustand/vanilla'

import { SCHEMA_VERSION, textFromString, type FormSchema } from '@entities/formSchema'
import { type Form } from '../../../entities/form'
import { createBuilderStore, type BuilderStore } from './store'
import { useAutosave, type FormRef } from './useAutosave'

// Ленивое создание формы (features/forms/draft.ts). Кнопка «Новая форма» открывает
// полотно, ничего не создавая: форму заводит ПЕРВОЕ обращение к ней. Отсюда два
// требования, и второе ловится только тестом.
//
// Первое: открыть форму и уйти, не тронув, — значит не создать её вовсе. Требование
// владельца, из-за него задача и делалась (история — JOURNAL, «Задача вне плана. Форма
// заводится первой правкой»).
//
// Второе: обращений к форме несколько (автосейв, загрузка обложки, публикация,
// настройки закрытия), и создать её они обязаны ОДИН раз. Две формы вместо одной —
// не косметика: полотно уедет сохраняться в первую, а вторая останется сиротой в
// списке, и увидит это только автор.

const saveDraftSchema = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ saveDraftSchema }))

const CREATED: Form = {
  id: 'form-1',
  name: null,
  title: 'Untitled form',
  slug: 'abcdefghij',
  status: 'draft',
  createdAt: '2026-08-22T10:00:00.000Z',
  updatedAt: '2026-08-22T10:00:00.000Z',
  publishedVersion: null,
  publishedVersionId: null,
  hasUnpublishedChanges: false,
  submissionCount: 0,
  lastSubmissionAt: null,
  visitCount: 0,
  visitSubmittedCount: 0,
}

const QUESTION: FormSchema = {
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Как вас зовут?') },
    { id: 'inp', groupId: 'g1', type: 'short_text' },
  ],
}

const create = vi.fn<() => Promise<Form>>()
const onCreated = vi.fn()

// Полотно нового черновика: формы нет, id и slug пусты — ровно то, что маршрут
// отдаёт билдеру до первого обращения к серверу.
function Probe({
  store,
  onReady,
}: {
  store: StoreApi<BuilderStore>
  onReady?: (ensureForm: () => Promise<FormRef>) => void
}) {
  const { ensureForm } = useAutosave(store, '', '', '', { create, onCreated })
  onReady?.(ensureForm)
  return null
}

function setup(schema: FormSchema = { schemaVersion: SCHEMA_VERSION, blocks: [] }) {
  const store = createBuilderStore()
  store.getState().hydrate(schema)
  let ensure: (() => Promise<FormRef>) | null = null
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <Probe store={store} onReady={(e) => (ensure = e)} />
    </QueryClientProvider>,
  )
  return { store, ensureForm: () => ensure!(), ...view }
}

beforeEach(() => {
  saveDraftSchema.mockReset()
  saveDraftSchema.mockResolvedValue({ ...CREATED, updatedAt: '2026-08-22T10:00:01.000Z' })
  create.mockReset()
  create.mockResolvedValue(CREATED)
  onCreated.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('форма заводится не раньше, чем понадобится', () => {
  it('открыли и ушли, не тронув, — формы не появилось', () => {
    const { unmount } = setup()

    unmount()

    expect(create).not.toHaveBeenCalled()
    expect(saveDraftSchema).not.toHaveBeenCalled()
  })

  it('пустой черновик не создаётся и по дебаунсу', async () => {
    setup()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(create).not.toHaveBeenCalled()
  })

  it('первая правка создаёт форму и сохраняет в неё схему', async () => {
    const { store } = setup(QUESTION)

    act(() => {
      store.getState().updateBlock('inp', { required: true })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(onCreated).toHaveBeenCalledWith(CREATED)
    // Схема уезжает в ТОЛЬКО ЧТО созданную форму, а токеном блокировки служит её
    // updatedAt: кэша detail у неё ещё нет, и взять токен больше неоткуда.
    expect(saveDraftSchema).toHaveBeenCalledTimes(1)
    expect(saveDraftSchema.mock.calls[0]![0]).toBe(CREATED.id)
    expect(saveDraftSchema.mock.calls[0]![2]).toBe(CREATED.updatedAt)
  })

  it('второе сохранение идёт в ту же форму, со свежим токеном', async () => {
    const { store } = setup(QUESTION)

    act(() => store.getState().updateBlock('inp', { required: true }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    act(() => store.getState().updateBlock('inp', { required: false }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(saveDraftSchema).toHaveBeenCalledTimes(2)
    expect(saveDraftSchema.mock.calls[1]![0]).toBe(CREATED.id)
    expect(saveDraftSchema.mock.calls[1]![2]).toBe('2026-08-22T10:00:01.000Z')
  })

  it('обложка раньше первой правки заводит форму сама', async () => {
    const { ensureForm } = setup()

    const form = await act(async () => ensureForm())

    expect(create).toHaveBeenCalledTimes(1)
    expect(form).toEqual({ id: CREATED.id, slug: CREATED.slug })
    // Одна лишь загрузка картинки схему не двигает — сохранять нечего.
    expect(saveDraftSchema).not.toHaveBeenCalled()
  })

  it('одновременные обращения создают ОДНУ форму', async () => {
    const { store, ensureForm } = setup(QUESTION)

    const [a, b] = await act(async () => {
      const first = ensureForm()
      const second = ensureForm()
      act(() => store.getState().updateBlock('inp', { required: true }))
      await vi.advanceTimersByTimeAsync(1000)
      return Promise.all([first, second])
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(saveDraftSchema).toHaveBeenCalledTimes(1)
  })

  it('провал создания не запирает черновик — следующая правка пробует снова', async () => {
    create.mockRejectedValueOnce(new Error('сеть'))
    const { store } = setup(QUESTION)

    act(() => store.getState().updateBlock('inp', { required: true }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(saveDraftSchema).not.toHaveBeenCalled()

    act(() => store.getState().updateBlock('inp', { required: false }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(create).toHaveBeenCalledTimes(2)
    expect(saveDraftSchema).toHaveBeenCalledTimes(1)
  })
})
