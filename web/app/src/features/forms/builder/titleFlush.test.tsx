// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { FormTitleInput } from './SlashEditor'

// Регрессия на молчаливую потерю названия формы. Название — единственное поле
// полотна вне стора билдера (серверный rename отдельной колонки forms.title),
// поэтому его не страхует ни автосейв схемы, ни его beforeunload-предупреждение:
// то смотрит store.dirty. Дебаунс 800 мс + cleanup, который таймер просто гасил,
// давали потерю на обычном действии — набрать название и сразу уйти с полотна
// (клик по «Ответы» в шапке, переключение в превью: SlashEditor размонтируется).
//
// Мутация ходит настоящая — до fetch, который здесь подменён: так проверяется
// весь путь (компонент → useRenameForm → renameForm → apiRequest), а не только
// то, что колбэк позвали.

const FORM_ID = 'form-1'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  // Фейковые таймеры здесь — суть проверки, а не удобство: на реальных дебаунс в
  // 800 мс успевает дотикать сам, и тест «blur отправляет» проходил бы даже без
  // флаша, просто медленно. С фейковыми единственный способ увидеть запрос без
  // явного advanceTimersByTime(800) — это флаш.
  vi.useFakeTimers()
  fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          id: FORM_ID,
          name: null,
          title: 'Опрос',
          slug: 's',
          status: 'draft',
          createdAt: '2026-07-26T10:00:00.000Z',
          updatedAt: '2026-07-26T10:00:01.000Z',
          publishedVersion: null,
          publishedVersionId: null,
          hasUnpublishedChanges: false,
          submissionCount: 0,
          visitCount: 0,
          visitSubmittedCount: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <FormTitleInput
        formId={FORM_ID}
        initialTitle="Без названия"
        onEnter={() => {}}
        titleRef={createRef<HTMLTextAreaElement>()}
      />
    </QueryClientProvider>,
  )
  const input = view.container.querySelector('textarea')!
  return { view, input }
}

// Тела ушедших PATCH'ей по названию формы (других запросов тут нет).
const sentTitles = () =>
  fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).title as string)

// settle — дать очереди микротасок разойтись, НЕ двигая часы: mutate доходит до
// fetch микротаском, а не синхронно. advanceTimersByTimeAsync(0) не запускает
// дебаунс-таймер (он на 800 мс) — значит, всё увиденное после settle пришло от
// флаша, а не от дебаунса.
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('название формы: дебаунс не должен съедать правку', () => {
  it('уход с полотна (размонтирование) уносит набранное, не дожидаясь дебаунса', async () => {
    const { view, input } = setup()

    fireEvent.change(input, { target: { value: 'Опрос' } })
    // Ни одного тика дебаунса не ждём — ровно как при клике по «Ответы» сразу
    // после набора.
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()

    view.unmount()
    await settle()

    expect(sentTitles()).toEqual(['Опрос'])
  })

  it('blur уносит набранное, не дожидаясь дебаунса', async () => {
    const { input } = setup()

    fireEvent.change(input, { target: { value: 'Анкета' } })
    fireEvent.blur(input)
    await settle()

    expect(sentTitles()).toEqual(['Анкета'])
  })

  it('без ухода и без blur правка всё ещё ждёт дебаунс (тот не сломан)', async () => {
    const { input } = setup()

    fireEvent.change(input, { target: { value: 'Опрос' } })
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(800)

    expect(sentTitles()).toEqual(['Опрос'])
  })

  it('пустое название не отправляем, и оно снимает назначенную правку', async () => {
    const { view, input } = setup()

    fireEvent.change(input, { target: { value: 'Опрос' } })
    fireEvent.change(input, { target: { value: '   ' } })
    view.unmount()
    await vi.advanceTimersByTimeAsync(800)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('повторный blur без новой правки второго запроса не делает', async () => {
    const { input } = setup()

    fireEvent.change(input, { target: { value: 'Опрос' } })
    fireEvent.blur(input)
    await settle()
    expect(sentTitles()).toEqual(['Опрос'])

    fireEvent.blur(input)
    await vi.advanceTimersByTimeAsync(800)

    expect(sentTitles()).toEqual(['Опрос'])
  })
})
