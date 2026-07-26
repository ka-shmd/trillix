// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { type FormDetail } from '../../entities/form'
import { formKeys } from './keys'
import { useRenameForm } from './queries'

// Гонка ремаунта полотна с летящим rename. Заголовок формы — НЕконтролируемое поле
// (defaultValue, ради нативного Ctrl+Z), и начальное значение оно берёт из кэша
// detail. Пока PATCH летит, полотно можно перемонтировать («Просмотр» → сразу
// «Редактор»), и без оптимистичного патча поле показало бы ещё старое название:
// правка выглядит потерянной, хотя на самом деле сохраняется.
//
// Поэтому ответ сервера здесь держим вручную — только так видно, что лежит в кэше
// В МОМЕНТ полёта, а не после него.

const FORM_ID = 'form-1'
const SLUG = 'anketa'
const T0 = '2026-07-26T10:00:00.000Z'

const detail = (title: string): FormDetail => ({
  id: FORM_ID,
  name: null,
  title,
  slug: SLUG,
  status: 'draft',
  createdAt: T0,
  updatedAt: T0,
  publishedVersion: null,
  publishedVersionId: null,
  hasUnpublishedChanges: false,
  submissionCount: 0,
  visitCount: 0,
  visitSubmittedCount: 0,
  draftSchema: { blocks: [] },
  closeAt: null,
  responseLimit: null,
  closedMessage: null,
  notifyOnSubmission: false,
})

// Ответ PATCH /forms/{id} — карточка формы (не деталь).
const renamedCard = () =>
  new Response(
    JSON.stringify({
      id: FORM_ID,
      name: null,
      title: 'Опрос',
      slug: SLUG,
      status: 'draft',
      createdAt: T0,
      updatedAt: '2026-07-26T10:00:05.000Z',
      publishedVersion: null,
      publishedVersionId: null,
      hasUnpublishedChanges: false,
      submissionCount: 0,
      visitCount: 0,
      visitSubmittedCount: 0,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// setup — кэш с деталью формы и подвешенный fetch: ответ отдаёт settle(), отказ —
// fail(). Пока ни то ни другое не позвано, мутация «в полёте».
function setup() {
  let settle!: (r: Response) => void
  let fail!: (e: Error) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((res, rej) => {
          settle = res
          fail = rej
        }),
    ),
  )
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  qc.setQueryData<FormDetail>(formKeys.detail(SLUG), detail('Без названия'))
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useRenameForm(), { wrapper })
  return { qc, result, settle: () => settle(renamedCard()), fail: () => fail(new Error('сеть')) }
}

// Что прочитает перемонтированное полотно.
const cachedTitle = (qc: QueryClient) => qc.getQueryData<FormDetail>(formKeys.detail(SLUG))?.title
const cachedUpdatedAt = (qc: QueryClient) =>
  qc.getQueryData<FormDetail>(formKeys.detail(SLUG))?.updatedAt

describe('rename: оптимистичный заголовок в detail', () => {
  it('заголовок виден в кэше, пока PATCH ещё летит — ремаунт покажет новый', async () => {
    const { qc, result, settle } = setup()

    await act(async () => {
      result.current.mutate({ id: FORM_ID, title: 'Опрос' })
    })

    // Ответа сервера ещё НЕ было.
    expect(cachedTitle(qc)).toBe('Опрос')
    // updatedAt при этом не трогаем: он токен оптимистичной блокировки автосейва
    // схемы (formLockToken), придумывать ему значение до ответа нельзя.
    expect(cachedUpdatedAt(qc)).toBe(T0)

    await act(async () => {
      settle()
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(cachedTitle(qc)).toBe('Опрос')
    expect(cachedUpdatedAt(qc)).toBe('2026-07-26T10:00:05.000Z')
  })

  it('неудачный PATCH откатывает заголовок, а не оставляет несохранённое имя', async () => {
    const { qc, result, fail } = setup()

    await act(async () => {
      result.current.mutate({ id: FORM_ID, title: 'Опрос' })
    })
    expect(cachedTitle(qc)).toBe('Опрос')

    await act(async () => {
      fail()
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(cachedTitle(qc)).toBe('Без названия')
  })

  it('чужая форма не задевается: detail ищется по id, а ключуется slug', async () => {
    const { qc, result, settle } = setup()
    qc.setQueryData<FormDetail>(formKeys.detail('other'), {
      ...detail('Чужая форма'),
      id: 'form-2',
      slug: 'other',
    })

    await act(async () => {
      result.current.mutate({ id: FORM_ID, title: 'Опрос' })
    })

    expect(qc.getQueryData<FormDetail>(formKeys.detail('other'))?.title).toBe('Чужая форма')

    await act(async () => {
      settle()
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })
})
