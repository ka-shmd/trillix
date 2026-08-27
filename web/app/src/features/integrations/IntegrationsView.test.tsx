// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ConnectedAccount, FormIntegrations, FormSheet } from '../../entities/integration'
import { IntegrationsView } from './IntegrationsView'
import { integrationKeys } from './keys'

// Поход к провайдеру идёт в отдельном окне, которого в happy-dom нет. Подменяем
// хук окна: он отдаёт наверх исход, а тест решает, каким тот будет.
const popup = vi.hoisted(() => ({
  callbacks: [] as ((outcome: string) => void)[],
  // waiting — идёт поход за согласием. Меняется тестом ДО рендера: проверяется
  // вид окна в этом состоянии, а не переход в него (переход — забота хука, у
  // него свои тесты).
  waiting: false,
  cancelled: false,
}))

// Список таблиц, который НИКОГДА не приезжает. Ловить «запрос в полёте» на живом
// fetch нельзя: в happy-dom он падает на ECONNREFUSED за миллисекунды, и тест
// проверял бы, кто успел первым. Мок трогает только один вызов; остальные тесты
// сеют список в кэш и до него не доходят (staleTime 30 с).
const hangingList = vi.hoisted(() => ({ enabled: false }))

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    listSpreadsheets: (accountId: string) =>
      hangingList.enabled ? new Promise<never>(() => {}) : actual.listSpreadsheets(accountId),
  }
})

vi.mock('../../shared/oauthPopup', () => ({
  useOAuthPopup: (onOutcome: (outcome: string) => void) => {
    popup.callbacks.push(onOutcome)
    return {
      waiting: popup.waiting,
      open: () => true,
      cancel: () => {
        popup.cancelled = true
      },
    }
  },
}))

// popupOutcome — окно провайдера вернулось с таким исходом.
function popupOutcome(outcome: string) {
  for (const cb of popup.callbacks) cb(outcome)
}

// Экран интеграций — два блока и оверлей настроек. Проверяется то, что человек
// видит и на что жмёт: состояния говорят РАЗНОЕ про одно и то же («не настроено
// на контуре» ≠ «не подключено» ≠ «подключено, но связок нет»), и спутать их
// значит советовать нажать кнопку, которой не появится.

afterEach(() => {
  cleanup()
  popup.waiting = false
  popup.cancelled = false
})

const FORM_ID = 'form-1'
const ACCOUNT_ID = 'acc-1'

// account — подключённый аккаунт человека. Их сколько угодно (ADR §10), поэтому
// фикстура параметризована: половина новых проверок про ВТОРОЙ.
function account(patch: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: ACCOUNT_ID,
    email: 'author@gmail.com',
    needsReconnect: false,
    connectedAt: '2026-08-27T10:00:00Z',
    ...patch,
  }
}

const CONNECTED = {
  enabled: true,
  pickerEnabled: true,
  accounts: [account()],
}

// conn — связка в состоянии «работает», если не сказано иное.
function conn(patch: Partial<FormSheet> = {}): FormSheet {
  return {
    id: 'conn-1',
    url: 'https://docs.google.com/spreadsheets/d/x/edit',
    accountId: ACCOUNT_ID,
    accountEmail: 'author@gmail.com',
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
    account: {
      enabled: true,
      pickerEnabled: false,
      accounts: [],
    },
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
//
// seedSpreadsheets=false оставляет список таблиц НЕпосеянным — запрос уходит и
// остаётся в полёте. Это единственный способ поймать состояние «что-то ещё едет»,
// ради которого в окне есть индикатор.
// Отдаёт клиент: часть проверок доигрывает приезд НОВЫХ данных (аккаунт
// подключился в соседнем окне) — для этого их надо положить в кеш после рендера.
function renderView(data: FormIntegrations, { seedSpreadsheets = true } = {}) {
  const qc = newTestClient()
  qc.setQueryData(integrationKeys.form(FORM_ID), data)
  if (seedSpreadsheets) {
    qc.setQueryData(integrationKeys.spreadsheets(FORM_ID, ACCOUNT_ID), [
      { id: 'ss-old', name: 'Прошлая форма' },
    ])
  }
  render(
    <QueryClientProvider client={qc}>
      <IntegrationsView formId={FORM_ID} />
    </QueryClientProvider>,
  )
  return qc
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
  // Блок ситуативный: при нуле связок его нет вовсе. Пустое состояние здесь было бы
  // вторым голосом — каталог прямо под ним предлагает то же самое.
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

  // Ключ контура сменился — подключение осталось строкой в базе, но работать им
  // нельзя. Экран обязан сказать это до того, как человек потеряет ответ. Говорит
  // строка связки: в каталоге состояния аккаунта больше нет.
  it('доступ к аккаунту потерян — строка связки говорит «заново»', () => {
    renderView(
      state({
        account: { ...CONNECTED, accounts: [account({ needsReconnect: true })] },
        connections: [conn({ name: 'Архив' })],
      }),
    )

    expect(screen.getByText(/Доступ к Google потерян/)).toBeTruthy()
    // Связка живая по своему статусу, но кружок обязан быть красным: чинится
    // аккаунт, а не она.
    expect(screen.getByRole('img', { name: 'Сломано' })).toBeTruthy()
  })

  // Состояние аккаунта ушло из каталога в окно подключения: плитка отвечает на
  // «что это такое», а не на «почему у меня не выйдет».
  it('провайдер не настроен на контуре — так написано в окне подключения', () => {
    renderView(
      state({
        account: { enabled: false, pickerEnabled: false, accounts: [] },
      }),
    )
    openSetup()

    expect(screen.getByText(/на этом контуре интеграция не настроена/i)).toBeTruthy()
  })

  it('состояние связки видно кружком и подписью', () => {
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

  // Половина настроек зависит от того, что приедет (какие таблицы, какие листы),
  // поэтому окно не показывает индикатор рядом с полями, а закрывает их: трогать
  // раньше — это выбирать из пустого списка.
  it('пока списки едут — окно закрыто индикатором, а поля выключены', async () => {
    hangingList.enabled = true
    try {
      renderView(state({ account: CONNECTED }), { seedSpreadsheets: false })
      openSetup()

      // Счётчик useIsFetching доезжает до родителя подпиской, а не тем же тиком.
      await waitFor(() => expect(screen.getByText(/загружаем данные google/i)).toBeTruthy())
      // inert выключает поддержку и мыши, и клавиатуры — слой поверх сам по себе
      // не помешал бы дойти до полей табом.
      const column = screen.getByLabelText(/название подключения/i).closest('[inert]')
      expect(column).not.toBeNull()
    } finally {
      hangingList.enabled = false
    }
  })

  // Ожидание согласия — такое же «окно занято», как и загрузка списков, и
  // показывается ТЕМ ЖЕ слоем. Отдельная строка в колонке говорила бы про
  // занятость вторым способом в одном окне, и настройки под ней оставались бы
  // живыми, пока человек в окне Google.
  it('идёт поход за согласием — общий слой поверх окна, поля выключены', () => {
    popup.waiting = true
    renderView(state({ account: CONNECTED }))
    openSetup()

    expect(screen.getByText(/ждём подтверждения в окне google/i)).toBeTruthy()
    // «Отменить» лежит В СЛОЕ: колонка на это время inert, и кнопка в ней была
    // бы недостижима ни мышью, ни клавиатурой.
    const cancel = screen.getByRole('button', { name: 'Отменить' })
    expect(screen.getByLabelText(/название подключения/i).closest('[inert]')).not.toBeNull()
    expect(cancel.closest('[inert]')).toBeNull()

    fireEvent.click(cancel)
    expect(popup.cancelled).toBe(true)
  })

  it('списки приехали — индикатора нет и поля живые', () => {
    renderView(state({ account: CONNECTED }))
    openSetup()

    expect(screen.queryByText(/загружаем данные google/i)).toBeNull()
    expect(screen.getByLabelText(/название подключения/i).closest('[inert]')).toBeNull()
  })

  it('аккаунт не подключён — предупреждение и вход в согласие, настроек ещё нет', () => {
    renderView(state())
    openSetup()

    expect(screen.getByRole('link', { name: /подключить google$/i })).toBeTruthy()
    // Про вывоз персональных данных оверлей говорит ДО подключения, а не после
    // (спека design/integrations-gsheets.md §10). Проверка стоит здесь, потому что
    // строку легко снести как «лишний текст»: она про 152-ФЗ, а не про UX.
    expect(screen.getByText(/персональные данные/i)).toBeTruthy()
    // Поля, которые всё равно заперты, — обещание работы, которой человек ещё
    // не может сделать: их здесь нет вовсе.
    expect(screen.queryByLabelText(/название подключения/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /подключить google таблицы/i })).toBeNull()
  })

  // Аккаунт Google принадлежит ЧЕЛОВЕКУ, и роль в пространстве его не гейтит
  // (ADR §10): подключить свой Диск вправе любой, кто дошёл до этого экрана.
  // Отказ по роли на этом экране — регрессия, и тест стоит именно за этим.
  it('подключение не спрашивает роль в пространстве', () => {
    renderView(state())
    openSetup()

    expect(screen.getByRole('link', { name: /подключить google$/i })).toBeTruthy()
    expect(screen.queryByText(/может владелец пространства/i)).toBeNull()
  })

  // Аккаунтов у человека сколько угодно, и выбирает он их там же, где таблицу.
  // В СПИСКЕ только аккаунты: работа с подключением стоит под ним ссылками, а не
  // пунктами выбора (решение владельца 2026-08-27, образец — Tally).
  it('в списке аккаунтов только аккаунты, действия — под ним', () => {
    renderView(
      state({
        account: {
          ...CONNECTED,
          accounts: [account(), account({ id: 'acc-2', email: 'work@gmail.com' })],
        },
      }),
    )
    openSetup()

    // У живого аккаунта действие ровно одно. «Переподключить» — лечение, и вне
    // беды оно предлагало бы чинить работающее; функционально оно к соседней
    // ссылке ничего не добавляет (тот же адрес, вся разница — в подсказке).
    expect(screen.getByRole('button', { name: /подключить другой аккаунт/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^переподключить$/i })).toBeNull()
    // Отключения здесь нет и быть не должно: оно рвёт аккаунт целиком и уносит
    // каскадом связки других форм и пространств, а окно — про одну связку.
    expect(screen.queryByRole('button', { name: /отключить/i })).toBeNull()

    fireEvent.click(screen.getByLabelText('Аккаунт Google'))
    expect(screen.getByRole('option', { name: 'author@gmail.com' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'work@gmail.com' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /подключить другой аккаунт/i })).toBeNull()
  })

  // Обе ссылки ведут на один адрес согласия, и различает их подсказка: у
  // «Переподключить» с собой едет id выбранного аккаунта, из которого сервер
  // берёт почту для login_hint. Без неё человек снова выбирал бы аккаунт руками
  // — то есть кнопка обещала бы то, чего не делает.
  // Оба действия ведут на ШАГ СОГЛАСИЯ, а не прямо в окно Google: на этом шаге
  // стоит строка о передаче персональных данных, и она обязана предварять каждую
  // выдачу доступа, а не только первую.
  it('«Подключить другой» открывает шаг согласия без подсказки', () => {
    renderView(state({ account: CONNECTED }))
    openSetup()
    fireEvent.click(screen.getByRole('button', { name: /подключить другой аккаунт/i }))

    expect(screen.getByText(/персональные данные/i)).toBeTruthy()
    const go = screen.getByRole('link', { name: /^подключить google$/i })
    expect(go.getAttribute('href')).not.toContain('accountId')
    // Настройки на это время убраны: шаг занимает окно целиком.
    expect(screen.queryByLabelText(/название подключения/i)).toBeNull()
  })

  // У переподключения тот же шаг, но с подсказкой: сервер возьмёт почту
  // названного аккаунта и передаст её Google, чтобы человек попал сразу в него.
  it('«Переподключить» открывает тот же шаг и несёт id аккаунта', () => {
    renderView(state({ account: { ...CONNECTED, accounts: [account({ needsReconnect: true })] } }))
    openSetup()
    fireEvent.click(screen.getByRole('button', { name: /^переподключить$/i }))

    expect(screen.getByText(/персональные данные/i)).toBeTruthy()
    const go = screen.getByRole('link', { name: /^подключить заново$/i })
    expect(go.getAttribute('href')).toContain(`accountId=${ACCOUNT_ID}`)
  })

  // Шаг — не тупик: с него можно вернуться к настройкам, не закрывая окно.
  it('с шага согласия можно вернуться к настройкам', () => {
    renderView(state({ account: CONNECTED }))
    openSetup()
    fireEvent.click(screen.getByRole('button', { name: /подключить другой аккаунт/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }))

    expect(screen.getByLabelText(/название подключения/i)).toBeTruthy()
  })

  // До первого подключения возвращаться некуда: за шагом пустой экран настроек.
  it('до первого подключения кнопки «Назад» нет', () => {
    renderView(state())
    openSetup()

    expect(screen.getByRole('link', { name: /^подключить google$/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull()
  })

  // Правка открывается ТЕМ ЖЕ окном, что и подключение (INTEGRATIONS §9), — со
  // всеми теми же полями, включая выбор аккаунта. Аккаунт существующей связки
  // менять можно: под drive.file это переезд вместе с таблицей, а не «оставить
  // лист, сменить владельца».
  it('у существующей связки аккаунт выбирается тем же полем', () => {
    renderView(
      state({
        account: {
          ...CONNECTED,
          accounts: [account(), account({ id: 'acc-2', email: 'work@gmail.com' })],
        },
        connections: [conn({ name: 'Архив' })],
      }),
    )
    openConnection()

    const dialog = within(screen.getByRole('dialog'))
    const select = dialog.getByLabelText('Аккаунт Google')
    expect(select.textContent).toContain('author@gmail.com')

    fireEvent.click(select)
    expect(screen.getByRole('option', { name: 'work@gmail.com' })).toBeTruthy()
  })

  // Человек нажал «подключить другой» ради нового аккаунта — он и должен остаться
  // выбранным. Иначе он делает вторым действием то, чего добивался первым.
  it('подключил новый аккаунт — выбранным становится он', async () => {
    const qc = renderView(state({ account: CONNECTED }))
    openSetup()
    expect(screen.getByLabelText('Аккаунт Google').textContent).toContain('author@gmail.com')

    // Так выглядит возвращение из окна Google: состояние перезапросилось и
    // приехало со вторым подключением.
    act(() => {
      qc.setQueryData(
        integrationKeys.form(FORM_ID),
        state({
          account: {
            ...CONNECTED,
            accounts: [account(), account({ id: 'acc-2', email: 'work@gmail.com' })],
          },
        }),
      )
    })

    await waitFor(() =>
      expect(screen.getByLabelText('Аккаунт Google').textContent).toContain('work@gmail.com'),
    )
  })

  // Переподключение прежнего аккаунта выбор НЕ трогает: новых id оно не даёт, а
  // человек может чинить один аккаунт, настраивая связку на другом. Сторожит
  // выбор «по новому id» против соблазна взять последний в списке — порядок идёт
  // по connected_at, и переподключённый тоже уезжает в конец.
  it('переподключил прежний аккаунт — выбор остаётся где был', async () => {
    const two = {
      ...CONNECTED,
      accounts: [account(), account({ id: 'acc-2', email: 'work@gmail.com' })],
    }
    const qc = renderView(state({ account: two }))
    openSetup()
    fireEvent.click(screen.getByLabelText('Аккаунт Google'))
    fireEvent.click(screen.getByRole('option', { name: 'work@gmail.com' }))
    expect(screen.getByLabelText('Аккаунт Google').textContent).toContain('work@gmail.com')

    act(() => {
      qc.setQueryData(
        integrationKeys.form(FORM_ID),
        state({
          account: {
            ...CONNECTED,
            // Тот же состав, но первый переподключён и уехал в конец списка.
            accounts: [
              account({ id: 'acc-2', email: 'work@gmail.com' }),
              account({ connectedAt: '2026-08-27T12:00:00Z' }),
            ],
          },
        }),
      )
    })

    await waitFor(() => expect(screen.getByLabelText('Аккаунт Google')).toBeTruthy())
    expect(screen.getByLabelText('Аккаунт Google').textContent).toContain('work@gmail.com')
  })

  // Вторая причина показать лечение: человек отозвал доступ в своём Google.
  // Токен при этом цел (needsReconnect=false), но провайдер отвечает
  // invalid_grant, и связка краснеет — узнаём по её статусу.
  it('связка сломана — «Переподключить» появляется у её аккаунта', () => {
    renderView(
      state({
        account: CONNECTED,
        connections: [conn({ status: 'broken', lastError: 'Доступ отозван.' })],
      }),
    )
    openConnection()

    expect(screen.getByRole('button', { name: /^переподключить$/i })).toBeTruthy()
  })

  // Перезалив — общее лекарство: дубль после ретрая, строки, удалённые автором
  // руками, отставшие колонки, раскладка, за которой мы перестали следовать.
  // Без входа в интерфейс из последней связка становилась тупиком: в кабинете
  // оставалось только удалить её и завести заново.
  it('перезалив спрашивает подтверждение и честно называет цену', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(new Response(null, { status: 202 }))
    })
    renderView(state({ account: CONNECTED, connections: [conn({ name: 'Архив' })] }))
    openConnection()
    fireEvent.click(screen.getByRole('button', { name: /перезалить лист/i }))

    // Цена названа: чистится ВЕСЬ лист, включая колонки автора.
    expect(screen.getByText(/включая колонки, которые вы добавили в него сами/i)).toBeTruthy()

    // Именно точное имя: рядом стоит кнопка «Перезалить лист», открывшая диалог.
    fireEvent.click(screen.getByRole('button', { name: /^Перезалить$/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/refill') && c.init?.method === 'POST')).toBe(true),
    )
    vi.unstubAllGlobals()
  })

  // Второй перезалив поверх идущего писал бы в тот же лист вперемешку с первым.
  it('пока идёт перенос — перезалить нельзя', () => {
    renderView(state({ account: CONNECTED, connections: [conn({ status: 'backfilling' })] }))
    openConnection()

    expect(screen.queryByRole('button', { name: /перезалить лист/i })).toBeNull()
  })

  // Смена аккаунта — это переезд: прежняя таблица новому аккаунту не видна, и
  // поле «Таблица» сбрасывается. Экран обязан сказать это до сохранения, иначе
  // человек ждёт, что данные останутся в прежнем листе.
  it('сменил аккаунт — окно предупреждает о переезде и сбрасывает таблицу', () => {
    renderView(
      state({
        account: {
          ...CONNECTED,
          accounts: [account(), account({ id: 'acc-2', email: 'work@gmail.com' })],
        },
        connections: [conn({ name: 'Архив', spreadsheetId: 'ss-old' })],
      }),
    )
    openConnection()
    fireEvent.click(screen.getByLabelText('Аккаунт Google'))
    fireEvent.click(screen.getByRole('option', { name: 'work@gmail.com' }))

    expect(screen.getByText(/прежняя таблица другому аккаунту недоступна/i)).toBeTruthy()
    expect(screen.getByLabelText('Таблица').textContent).toContain('Создать новую таблицу')
  })

  // Связку мог завести коллега: его подключения в списке спрашивающего нет, и
  // без отдельного пункта поле выглядело бы пустым — «через кого едет» пропало
  // бы с экрана вовсе.
  it('чужой аккаунт связки виден в поле и подписан', () => {
    renderView(
      state({
        account: CONNECTED,
        connections: [
          conn({ name: 'Архив', accountId: 'acc-colleague', accountEmail: 'colleague@gmail.com' }),
        ],
      }),
    )
    openConnection()

    expect(screen.getByLabelText('Аккаунт Google').textContent).toContain('colleague@gmail.com')
  })

  // Потерянный токен — про КОНКРЕТНЫЙ аккаунт: соседние продолжают работать, и
  // лечение адресное.
  it('у выбранного аккаунта потерян доступ — окно зовёт войти заново', () => {
    renderView(state({ account: { ...CONNECTED, accounts: [account({ needsReconnect: true })] } }))
    openSetup()

    expect(screen.getByText(/доступ к этому аккаунту потерян/i)).toBeTruthy()
    // Лечение — рядом, той же кнопкой: она ведёт на шаг согласия этого аккаунта.
    expect(screen.getByRole('button', { name: /^переподключить$/i })).toBeTruthy()
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
    expect(
      within(screen.getByRole('dialog')).getByText(/переносим ответы, которые уже пришли/i),
    ).toBeTruthy()
  })

  it('после подключения в окне провайдера состояние перезапрашивается', async () => {
    // Мина: окно провайдера поверх вкладки НЕ переводит документ в hidden, и
    // refetch по фокусу React Query (он слушает только visibilitychange) не
    // случится. Без явной инвалидации экран остался бы показывать «Подключить
    // Google» при уже подключённом аккаунте.
    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(String(url))
      return Promise.resolve(
        new Response(JSON.stringify({ workspaceId: 'ws-1', account: CONNECTED, connections: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })
    renderView(state())
    openSetup()
    // Само окно провайдера в happy-dom не открыть, да и проверяется здесь не
    // оно (у хука свои тесты), а НАША реакция на его исход.
    popupOutcome('integration_ok')

    await waitFor(() =>
      expect(calls.some((u) => u.endsWith(`/forms/${FORM_ID}/integrations`))).toBe(true),
    )
    vi.unstubAllGlobals()
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
      screen
        .getAllByRole('alert')
        .some((el) => /больше не принимает записи/i.test(el.textContent ?? '')),
    ).toBe(true)
    // Экран правки при этом остаётся формой: сохранить исправленное можно.
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeTruthy()
  })
})
