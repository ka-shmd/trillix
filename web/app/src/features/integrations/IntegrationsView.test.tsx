// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { FormIntegrations, FormSheet } from '../../entities/integration'
import { IntegrationsView } from './IntegrationsView'
import { integrationKeys } from './keys'

// Экран интеграций — два блока и оверлей настроек. Проверяется то, что человек
// видит и на что жмёт: состояния говорят РАЗНОЕ про одно и то же («не настроено
// на контуре» ≠ «не подключено» ≠ «подключено, но связок нет»), и спутать их
// значит советовать нажать кнопку, которой не появится.

afterEach(cleanup)

const FORM_ID = 'form-1'

const CONNECTED = {
  enabled: true,
  pickerEnabled: true,
  connected: true,
  canManage: true,
  email: 'author@gmail.com',
}

// conn — связка в состоянии «работает», если не сказано иное.
function conn(patch: Partial<FormSheet> = {}): FormSheet {
  return {
    id: 'conn-1',
    url: 'https://docs.google.com/spreadsheets/d/x/edit',
    spreadsheetId: 'ss-old',
    sheetId: 0,
    enabled: true,
    status: 'live',
    ...patch,
  }
}

function state(patch: Partial<FormIntegrations> = {}): FormIntegrations {
  return {
    workspaceId: 'ws-1',
    account: { enabled: true, pickerEnabled: false, connected: false, canManage: true },
    connections: [],
    ...patch,
  }
}

// newTestClient — клиент, который НЕ перезапрашивает посеянное: иначе в кейсе с
// отказом сети падает и само состояние экрана, и проверяется не то, что нужно.
function newTestClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
      mutations: { retry: false },
    },
  })
}

// Данные кладём прямо в кеш: экран проверяется по состоянию, а не по транспорту.
function renderView(data: FormIntegrations) {
  const qc = newTestClient()
  qc.setQueryData(integrationKeys.form(FORM_ID), data)
  qc.setQueryData([...integrationKeys.form(FORM_ID), 'spreadsheets'], [
    { id: 'ss-old', name: 'Прошлая форма' },
  ])
  render(
    <QueryClientProvider client={qc}>
      <IntegrationsView formId={FORM_ID} />
    </QueryClientProvider>,
  )
}

// Два входа в оверлей: из каталога — подключить ещё одну связку, из строки
// списка — настроить существующую.
function openSetup() {
  fireEvent.click(screen.getByRole('button', { name: 'Подключить' }))
}

function openConnection() {
  fireEvent.click(screen.getByRole('button', { name: 'Настроить подключение' }))
}

describe('два блока экрана', () => {
  it('связок нет — блока «Мои подключения» тоже нет', () => {
    renderView(state({ account: CONNECTED }))

    expect(screen.queryByText('Мои подключения')).toBeNull()
    expect(screen.getByText('Доступные интеграции')).toBeTruthy()
  })

  it('связки показаны отдельным блоком, каталог остаётся на месте', () => {
    renderView(state({ account: CONNECTED, connections: [conn({ name: 'Архив' })] }))

    expect(screen.getByText('Мои подключения')).toBeTruthy()
    expect(screen.getByText('Архив')).toBeTruthy()
    // Каталог не исчезает: подключить вторую связку — законное действие.
    expect(screen.getByRole('button', { name: 'Подключить' })).toBeTruthy()
  })

  it('провайдер не настроен на контуре — так и написано в каталоге', () => {
    renderView(state({ account: { enabled: false, pickerEnabled: false, connected: false, canManage: true } }))

    expect(screen.getByText(/на этом контуре интеграция не настроена/i)).toBeTruthy()
  })

  it('состояние связки видно точкой и подписью', () => {
    renderView(state({ account: CONNECTED, connections: [conn({ status: 'backfilling' })] }))

    expect(screen.getByLabelText('Переносим ответы')).toBeTruthy()
    expect(screen.getByText(/переносим накопленные ответы/i)).toBeTruthy()
  })

  it('выключенная связка помечена и не притворяется работающей', () => {
    renderView(state({ account: CONNECTED, connections: [conn({ enabled: false })] }))

    expect(screen.getByLabelText('Выключено')).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Включить подключение' })).toBeTruthy()
  })

  it('удаление спрашивает подтверждение и обещает сохранить таблицу', () => {
    renderView(state({ account: CONNECTED, connections: [conn()] }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить подключение' }))

    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.getByText(/останутся на вашем google диске/i)).toBeTruthy()
  })
})

describe('оверлей настройки Google Таблиц', () => {
  it('кнопка каталога открывает оверлей с настройками подключения', () => {
    renderView(state({ account: CONNECTED }))
    openSetup()

    expect(screen.getByRole('dialog')).toBeTruthy()
    // Те самые решения, которые принимаются ДО первой записи в чужие данные.
    expect(screen.getByLabelText(/название подключения/i)).toBeTruthy()
    expect(screen.getByLabelText(/таблица/i)).toBeTruthy()
    expect(screen.getByLabelText(/перенести уже накопленные ответы/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /подключить google таблицы/i })).toBeTruthy()
  })

  it('аккаунт не подключён — только рассказ и согласие, настроек ещё нет', () => {
    renderView(state())
    openSetup()

    expect(screen.getByRole('link', { name: /подключить google$/i })).toBeTruthy()
    // Про вывоз персональных данных оверлей говорит ДО подключения, а не после.
    expect(screen.getByText(/персональные данные/i)).toBeTruthy()
    // Поля, которые всё равно заперты, — обещание работы, которой человек ещё
    // не может сделать: их здесь нет вовсе.
    expect(screen.queryByLabelText(/название подключения/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /подключить google таблицы/i })).toBeNull()
  })

  it('редактор видит интеграцию, но подключает аккаунт владелец', () => {
    renderView(state({ account: { enabled: true, pickerEnabled: false, connected: false, canManage: false } }))
    openSetup()

    expect(screen.getByText(/подключить google может владелец/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /подключить google$/i })).toBeNull()
  })

  it('выбор таблицы — один дропдаун: новая, наши и «выбрать на Диске»', () => {
    renderView(state({ account: CONNECTED }))
    openSetup()
    fireEvent.click(screen.getByLabelText('Таблица'))

    // Три способа ответить на один вопрос «какая таблица» живут в одном списке,
    // а не растащены по кнопкам рядом с ним.
    expect(screen.getByRole('option', { name: /создать новую таблицу/i })).toBeTruthy()
    expect(screen.getByRole('option', { name: /прошлая форма/i })).toBeTruthy()
    expect(screen.getByRole('option', { name: /выбрать на google диске/i })).toBeTruthy()
  })

  it('окно выбора не настроено на контуре — пункта «выбрать на Диске» нет', () => {
    renderView(state({ account: { ...CONNECTED, pickerEnabled: false } }))
    openSetup()
    fireEvent.click(screen.getByLabelText('Таблица'))

    expect(screen.getByRole('option', { name: /создать новую таблицу/i })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /выбрать на google диске/i })).toBeNull()
  })

  it('у новой таблицы выбора листа нет — он заводится вместе с ней', () => {
    renderView(state({ account: CONNECTED }))
    openSetup()

    expect(screen.queryByLabelText('Лист')).toBeNull()
  })

  it('Google отказал в списке таблиц — экран метит поле значком, а не абзацем', async () => {
    // Пустой список читается как «у меня нет таблиц», хотя на деле отказал
    // провайдер, — и человек чинит не то. Но и объяснять ему нечего: причина в
    // настройках нашего проекта Google Cloud.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('403')))
    const qc = newTestClient()
    qc.setQueryData(integrationKeys.form(FORM_ID), state({ account: CONNECTED }))
    render(
      <QueryClientProvider client={qc}>
        <IntegrationsView formId={FORM_ID} />
      </QueryClientProvider>,
    )
    openSetup()

    await waitFor(() => expect(screen.getByLabelText('Не удалось загрузить')).toBeTruthy())
    vi.unstubAllGlobals()
  })

  it('на время выбора файла оверлей перестаёт запирать страницу', async () => {
    // Мина: окно Picker'а Google рисуется своим узлом в body, а модальный
    // диалог гасит pointer-events у всего, что вне его содержимого. Окно видно —
    // и оно мёртвое.
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    renderView(state({ account: CONNECTED }))
    openSetup()
    expect(document.body.style.pointerEvents).toBe('none')

    fireEvent.click(screen.getByLabelText('Таблица'))
    fireEvent.click(screen.getByRole('option', { name: /выбрать на google диске/i }))

    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'))
    vi.unstubAllGlobals()
  })

  it('открытие окна выбора не сбрасывает уже набранные настройки', async () => {
    // Смена модальности перемонтирует поддерево Radix вместе с локальным
    // стейтом — снаружи это выглядело как «оверлей перезагрузился, выбор ничего
    // не дал».
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    renderView(state({ account: CONNECTED }))
    openSetup()
    fireEvent.change(screen.getByLabelText(/название подключения/i), {
      target: { value: 'Заявки с лендинга' },
    })

    fireEvent.click(screen.getByLabelText('Таблица'))
    fireEvent.click(screen.getByRole('option', { name: /выбрать на google диске/i }))
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe('none'))

    expect((screen.getByLabelText(/название подключения/i) as HTMLInputElement).value).toBe(
      'Заявки с лендинга',
    )
    vi.unstubAllGlobals()
  })

  it('карандаш открывает ТОТ ЖЕ экран, что и подключение, — с подставленными значениями', () => {
    renderView(state({ account: CONNECTED, connections: [conn({ name: 'Архив' })] }))
    openConnection()

    // Те же поля, что при подключении, и в них — сегодняшние значения связки.
    expect((screen.getByLabelText(/название подключения/i) as HTMLInputElement).value).toBe('Архив')
    expect(screen.getByLabelText('Таблица')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeTruthy()
    // Отдельного «второго меню» больше нет: кнопка подключения не показывается.
    expect(screen.queryByRole('button', { name: /подключить google таблицы/i })).toBeNull()
  })

  it('состояние связки видно на экране правки первым делом', () => {
    renderView(state({ account: CONNECTED, connections: [conn({ status: 'backfilling' })] }))
    openConnection()

    // Человек открыл связку, скорее всего, потому что что-то не так, — и первое,
    // что он видит, это что с ней сейчас.
    expect(screen.getByText(/переносим ответы/i)).toBeTruthy()
  })

  it('сохранение правки несёт ВЫБРАННУЮ таблицу, а не только подпись', async () => {
    // Мина: хук правки легко написать так, что он отправит name и enabled, а
    // выбранную цель молча выбросит — и переезд в другой лист тихо не сработает.
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(new Response(null, { status: 204 }))
    })
    renderView(state({ account: CONNECTED, connections: [conn({ name: 'Архив' })] }))
    openConnection()

    // Меняем цель на «создать новую таблицу» и сохраняем.
    fireEvent.click(screen.getByLabelText('Таблица'))
    fireEvent.click(screen.getByRole('option', { name: /создать новую таблицу/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true))
    const patch = calls.find((c) => c.init?.method === 'PATCH')!
    const body = JSON.parse(String(patch.init?.body))
    expect(body.name).toBe('Архив')
    expect(body).toHaveProperty('spreadsheetId')
    vi.unstubAllGlobals()
  })

  it('сломанная связка показывает причину, а не молчит', () => {
    renderView(
      state({
        account: CONNECTED,
        connections: [
          conn({ status: 'broken', lastError: 'Google больше не принимает записи в эту таблицу.' }),
        ],
      }),
    )
    openConnection()

    expect(
      screen.getAllByRole('alert').some((el) => /больше не принимает записи/i.test(el.textContent ?? '')),
    ).toBe(true)
    // Экран правки при этом остаётся формой: сохранить исправленное можно.
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeTruthy()
  })
})
