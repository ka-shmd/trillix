// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SCHEMA_VERSION, textFromString, type FormSchema } from '@entities/formSchema'
import { type FormDetail } from '../../../entities/form'
import { newFormDetail } from '../draft'
import { formKeys } from '../keys'
import { DiscardChanges } from './DiscardChanges'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'

// Откат черновика необратим (решение владельца 2026-09-14): запрос уходит только после
// подтверждения, полотно получает опубликованную версию без истории правок.

const schema = (caption: string): FormSchema => ({
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    { id: 't1', groupId: 'g1', type: 'title', text: textFromString(caption) },
    { id: 'q1', groupId: 'g1', type: 'short_text' },
  ],
})

const DETAIL: FormDetail = {
  ...newFormDetail(),
  id: 'f1',
  slug: 'anketa',
  status: 'published',
  createdAt: '2026-09-14T10:00:00Z',
  updatedAt: '2026-09-14T11:00:00Z',
  publishedVersion: 1,
  publishedVersionId: 'v1',
  hasUnpublishedChanges: true,
  draftSchema: schema('Имя и фамилия'),
}

// Ответ ручки: черновик равен опубликованной версии, токен сдвинут.
const FRESH: FormDetail = {
  ...DETAIL,
  updatedAt: '2026-09-14T12:00:00Z',
  hasUnpublishedChanges: false,
  draftSchema: schema('Имя'),
}

let posts: { url: string; body: unknown }[] = []

beforeEach(() => {
  posts = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) })
      return Promise.resolve(
        new Response(JSON.stringify(FRESH), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function setup(canDiscard: boolean) {
  const store = createBuilderStore()
  store.getState().hydrate(DETAIL.draftSchema)
  // Правка поверх загрузки — чтобы откату было что обнулять в истории.
  store.getState().applyExternal(schema('Имя, фамилия и отчество'))
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  qc.setQueryData(formKeys.detail(DETAIL.slug), DETAIL)

  // Деталь — из кэша, как у маршрута редактора: ответ отката обязан погасить плашку.
  function Harness() {
    const { data } = useQuery({
      queryKey: formKeys.detail(DETAIL.slug),
      queryFn: () => DETAIL,
      enabled: false,
    })
    return data ? <DiscardChanges form={data} canDiscard={canDiscard} /> : null
  }

  render(
    <QueryClientProvider client={qc}>
      <BuilderStoreContext.Provider value={store}>
        <Harness />
      </BuilderStoreContext.Provider>
    </QueryClientProvider>,
  )
  return store
}

it('плашка открывает окно, а откат уходит только после подтверждения', async () => {
  const store = setup(true)

  fireEvent.click(screen.getByRole('button', { name: 'Есть изменения' }))
  await screen.findByRole('heading', { name: 'Удалить изменения?' })
  expect(posts).toEqual([])

  fireEvent.click(screen.getByRole('button', { name: 'Удалить изменения' }))
  await waitFor(() =>
    expect(posts).toEqual([
      { url: '/api/v1/forms/f1/discard-draft', body: { updatedAt: DETAIL.updatedAt } },
    ]),
  )

  // Полотно — опубликованная версия, и Ctrl+Z к удалённым правкам не ведёт.
  await waitFor(() =>
    expect(store.getState().blocks.find((b) => b.id === 't1')?.text).toEqual(
      textFromString('Имя'),
    ),
  )
  expect(store.getState().past).toEqual([])
  expect(store.getState().dirty).toBe(false)
  // Кэш детали получил ответ — плашка погасла.
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Есть изменения' })).toBeNull(),
  )
})

it('пока черновик не догнал редактор, удалить изменения нельзя', async () => {
  setup(false)

  fireEvent.click(screen.getByRole('button', { name: 'Есть изменения' }))
  await screen.findByRole('heading', { name: 'Удалить изменения?' })
  const confirm = screen.getByRole('button', { name: 'Удалить изменения' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
})
