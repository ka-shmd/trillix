// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { FormIntegrations } from '../../entities/integration'
import { IntegrationsView } from './IntegrationsView'
import { integrationKeys } from './keys'

// Экран интеграций — список плюс окно настроек, и оба говорят человеку РАЗНОЕ
// про одно и то же: «не настроено на контуре» ≠ «не подключено» ≠ «подключено,
// но форма не привязана». Спутать их значит советовать нажать кнопку, которой у
// человека не появится, — поэтому состояния проверяются по видимому тексту.

afterEach(cleanup)

const FORM_ID = 'form-1'

function state(patch: Partial<FormIntegrations> = {}): FormIntegrations {
  return {
    workspaceId: 'ws-1',
    account: { enabled: true, pickerEnabled: false, connected: false, canManage: true },
    sheet: null,
    ...patch,
  }
}

// Данные кладём прямо в кеш: экран проверяется по состоянию, а не по транспорту,
// и мок fetch добавил бы к каждому кейсу асинхронность, которой в нём нет.
function renderView(data: FormIntegrations) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  qc.setQueryData(integrationKeys.form(FORM_ID), data)
  // Список таблиц — тоже из кеша: иначе окно ушло бы в сеть за выбором.
  qc.setQueryData([...integrationKeys.form(FORM_ID), 'spreadsheets'], [
    { id: 'ss-old', name: 'Прошлая форма' },
  ])
  render(
    <QueryClientProvider client={qc}>
      <IntegrationsView formId={FORM_ID} />
    </QueryClientProvider>,
  )
}

// openDialog — тот самый жест: клик по строке интеграции открывает её настройки.
function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: /google таблицы/i }))
}

const CONNECTED = {
  enabled: true,
  pickerEnabled: true,
  connected: true,
  canManage: true,
  email: 'author@gmail.com',
}

describe('список интеграций', () => {
  it('провайдер не настроен на контуре — так и написано в строке', () => {
    renderView(state({ account: { enabled: false, pickerEnabled: false, connected: false, canManage: true } }))

    expect(screen.getByRole('button', { name: /google таблицы/i }).textContent).toContain(
      'На этом контуре интеграция не настроена',
    )
  })

  it('привязанная форма показывает статус значком', () => {
    renderView(
      state({
        account: CONNECTED,
        sheet: { url: 'https://docs.google.com/spreadsheets/d/x/edit', status: 'backfilling' },
      }),
    )

    expect(screen.getByText('Переносим')).toBeTruthy()
  })

  it('настройки живут в оверлее: до клика полей нет', () => {
    renderView(state())

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText(/название подключения/i)).toBeNull()
  })
})

describe('оверлей настройки Google Таблиц', () => {
  it('клик по строке открывает оверлей с настройками подключения', () => {
    renderView(state({ account: CONNECTED }))
    openDialog()

    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    // Те самые решения, которые принимаются ДО первой записи в чужие данные.
    expect(screen.getByLabelText(/название подключения/i)).toBeTruthy()
    expect(screen.getByLabelText(/таблица/i)).toBeTruthy()
    expect(screen.getByLabelText(/перенести уже накопленные ответы/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /подключить google таблицы/i })).toBeTruthy()
  })

  it('аккаунт не подключён — только рассказ и согласие, настроек ещё нет', () => {
    renderView(state())
    openDialog()

    expect(screen.getByRole('link', { name: /подключить google$/i })).toBeTruthy()
    // Про вывоз персональных данных оверлей говорит ДО подключения, а не после.
    expect(screen.getByText(/персональные данные/i)).toBeTruthy()
    // Поля, которые всё равно заперты, — обещание работы, которой человек ещё
    // не может сделать: их здесь нет вовсе.
    expect(screen.queryByLabelText(/название подключения/i)).toBeNull()
    expect(screen.queryByLabelText(/таблица/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /подключить google таблицы/i })).toBeNull()
  })

  it('редактор видит интеграцию, но подключает аккаунт владелец', () => {
    renderView(state({ account: { enabled: true, pickerEnabled: false, connected: false, canManage: false } }))
    openDialog()

    expect(screen.getByText(/подключить google может владелец/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /подключить google$/i })).toBeNull()
  })

  it('выбор таблицы — один дропдаун: новая, наши и «выбрать на Диске»', () => {
    renderView(state({ account: CONNECTED }))
    openDialog()
    fireEvent.click(screen.getByLabelText('Таблица'))

    // Три способа ответить на один вопрос «какая таблица» живут в одном списке,
    // а не растащены по кнопкам рядом с ним.
    expect(screen.getByRole('option', { name: /создать новую таблицу/i })).toBeTruthy()
    expect(screen.getByRole('option', { name: /прошлая форма/i })).toBeTruthy()
    expect(screen.getByRole('option', { name: /выбрать на google диске/i })).toBeTruthy()
  })

  it('окно выбора не настроено на контуре — пункта «выбрать на Диске» нет', () => {
    renderView(state({ account: { ...CONNECTED, pickerEnabled: false } }))
    openDialog()
    fireEvent.click(screen.getByLabelText('Таблица'))

    expect(screen.getByRole('option', { name: /создать новую таблицу/i })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /выбрать на google диске/i })).toBeNull()
  })

  it('у новой таблицы выбора листа нет — он заводится вместе с ней', () => {
    renderView(state({ account: CONNECTED }))
    openDialog()

    expect(screen.queryByLabelText('Лист')).toBeNull()
  })

  it('идёт перенос — «Перезалить всё» недоступно, чтобы не запустить второй', () => {
    renderView(
      state({
        account: CONNECTED,
        sheet: { url: 'https://docs.google.com/spreadsheets/d/x/edit', status: 'backfilling' },
      }),
    )
    openDialog()

    expect(screen.getByText(/переносим ответы/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /перезалить всё/i }).hasAttribute('disabled')).toBe(
      true,
    )
  })

  it('сломанная интеграция показывает причину, а не молчит', () => {
    renderView(
      state({
        account: CONNECTED,
        sheet: {
          url: 'https://docs.google.com/spreadsheets/d/x/edit',
          status: 'broken',
          lastError: 'Google больше не принимает записи в эту таблицу.',
        },
      }),
    )
    openDialog()

    expect(screen.getByRole('alert').textContent).toContain('больше не принимает записи')
    // Отвязка остаётся доступной: это способ выйти из поломки.
    expect(screen.getByRole('button', { name: /отвязать форму/i })).toBeTruthy()
  })
})
