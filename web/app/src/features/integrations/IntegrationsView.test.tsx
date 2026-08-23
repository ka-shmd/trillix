// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { FormIntegrations } from '../../entities/integration'
import { IntegrationsView } from './IntegrationsView'
import { integrationKeys } from './keys'

// Экран интеграций — это машина состояний с шестью исходами, и половина из них
// говорит человеку РАЗНОЕ про одно и то же («не настроено на контуре» ≠ «не
// подключено» ≠ «подключено, но форма не привязана»). Спутать их значит советовать
// нажать кнопку, которой у человека не появится, — поэтому состояния проверяются
// по видимому тексту, а не по внутренним флагам.

afterEach(cleanup)

const FORM_ID = 'form-1'

function state(patch: Partial<FormIntegrations> = {}): FormIntegrations {
  return {
    workspaceId: 'ws-1',
    account: { enabled: true, connected: false, canManage: true },
    sheet: null,
    ...patch,
  }
}

// Данные кладём прямо в кеш: экран проверяется по состоянию, а не по транспорту,
// и мок fetch добавил бы к каждому кейсу асинхронность, которой в нём нет.
function renderView(data: FormIntegrations) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  qc.setQueryData(integrationKeys.form(FORM_ID), data)
  render(
    <QueryClientProvider client={qc}>
      <IntegrationsView formId={FORM_ID} />
    </QueryClientProvider>,
  )
}

describe('экран интеграций', () => {
  it('провайдер не настроен на контуре — кнопки нет вовсе', () => {
    renderView(state({ account: { enabled: false, connected: false, canManage: true } }))

    expect(screen.getByText(/интеграция не настроена/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /подключить google/i })).toBeNull()
  })

  it('редактор видит интеграцию, но подключает её владелец', () => {
    renderView(state({ account: { enabled: true, connected: false, canManage: false } }))

    expect(screen.getByText(/подключить google может владелец/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /подключить google/i })).toBeNull()
  })

  it('не подключено — ссылка на согласие и честное предупреждение о передаче данных', () => {
    renderView(state())

    expect(screen.getByRole('link', { name: /подключить google/i })).toBeTruthy()
    // Про вывоз персональных данных экран говорит ДО подключения, а не после.
    expect(screen.getByText(/персональные данные/i)).toBeTruthy()
  })

  it('аккаунт подключён, форма не привязана — предлагает завести таблицу', () => {
    renderView(state({ account: { enabled: true, connected: true, canManage: true, email: 'author@gmail.com' } }))

    expect(screen.getByText('author@gmail.com')).toBeTruthy()
    expect(screen.getByRole('button', { name: /создать таблицу/i })).toBeTruthy()
  })

  it('идёт перенос — «Перезалить всё» недоступно, чтобы не запустить второй', () => {
    renderView(
      state({
        account: { enabled: true, connected: true, canManage: true, email: 'author@gmail.com' },
        sheet: { url: 'https://docs.google.com/spreadsheets/d/x/edit', status: 'backfilling' },
      }),
    )

    expect(screen.getByText(/переносим ответы/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /перезалить всё/i }).hasAttribute('disabled')).toBe(true)
  })

  it('сломанная интеграция показывает причину, а не молчит', () => {
    renderView(
      state({
        account: { enabled: true, connected: true, canManage: true, email: 'author@gmail.com' },
        sheet: {
          url: 'https://docs.google.com/spreadsheets/d/x/edit',
          status: 'broken',
          lastError: 'Google больше не принимает записи в эту таблицу.',
        },
      }),
    )

    expect(screen.getByRole('alert').textContent).toContain('больше не принимает записи')
    // Отвязка формы остаётся доступной: это способ выйти из поломки.
    expect(screen.getByRole('button', { name: /отвязать форму/i })).toBeTruthy()
  })
})
