// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type {
  ConnectedAccount,
  FormIntegrations,
  FormSheet,
  Webhook,
} from '../../entities/integration'
import { IntegrationsView } from './IntegrationsView'
import { TooltipProvider } from '@/components/ui/tooltip'
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
    webhooks: [],
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
  // TooltipProvider повторяет окружение приложения: в кабинете его даёт
  // SidebarProvider выше по дереву. Без него точка состояния роняет рендер.
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <IntegrationsView formId={FORM_ID} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
  return qc
}

// Два входа в оверлей: из каталога — подключить ещё одну связку, из строки
// списка — настроить существующую.
function openSetup() {
  fireEvent.click(screen.getByRole('button', { name: 'Подключить Google Таблицы' }))
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
    // Строка говорит, зачем связка и куда ведёт ссылка; состояние — на точке.
    expect(screen.getByText(/ответы синхронизируются с/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'таблицей' })).toBeTruthy()
    // Каталог не исчезает: подключить вторую связку — законное действие.
    expect(screen.getByRole('button', { name: 'Подключить Google Таблицы' })).toBeTruthy()
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

    // Связка живая по своему статусу, но кружок обязан быть красным: чинится
    // аккаунт, а не она.
    const dot = screen.getByRole('button', { name: 'Сломано' })
    // Текст состояния живёт в тултипе: у поломки он длинный, и в строке под
    // названием обрезался бы на середине причины.
    fireEvent.focus(dot)
    // По роли, а не по тексту: Radix рисует содержимое дважды — видимым узлом и
    // копией для скринридера, и поиск по тексту находит оба.
    expect(screen.getByRole('tooltip').textContent).toMatch(/Доступ к Google потерян/)
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

  it('состояние связки видно кружком, подробности — в тултипе', () => {
    renderView(state({ account: CONNECTED, connections: [conn({ status: 'backfilling' })] }))

    const dot = screen.getByRole('button', { name: 'Переносим ответы' })
    fireEvent.focus(dot)
    expect(screen.getByRole('tooltip').textContent).toMatch(/переносим ответы, которые уже пришли/i)
  })

  // Точка пульсирует, пока состояние требует внимания или работы. У покоя
  // («работает», «выключено») пульса нет — иначе он перестал бы что-либо значить.
  it('пульсирует только то, что требует внимания', () => {
    const pulses = (el: HTMLElement) => el.querySelector('.animate-ping') !== null

    renderView(state({ account: CONNECTED, connections: [conn({ status: 'broken' })] }))
    expect(pulses(screen.getByRole('button', { name: 'Сломано' }))).toBe(true)
    cleanup()

    renderView(state({ account: CONNECTED, connections: [conn()] }))
    expect(pulses(screen.getByRole('button', { name: 'Работает' }))).toBe(false)
    cleanup()

    renderView(state({ account: CONNECTED, connections: [conn({ enabled: false })] }))
    expect(pulses(screen.getByRole('button', { name: 'Выключено' }))).toBe(false)
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

    // Действий под списком два, и «Переподключить» стоит ПОСТОЯННО (решение
    // владельца 2026-09-10): знание о смерти согласия всегда запаздывает — её
    // видно только в момент доставки, — и кнопка «по признаку поломки» не
    // появлялась ровно тогда, когда была нужна.
    expect(screen.getByRole('button', { name: /подключить другой аккаунт/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^переподключить$/i })).toBeTruthy()
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

  // Мёртвое подключение обязано быть видно В СПИСКЕ, а не только в предупреждении
  // под ним: аккаунт выбирают раньше, чем читают текст, и выбрать мёртвый рядом с
  // живым — это потерянные ответы.
  it('аккаунт с потерянным доступом помечен в самом списке', () => {
    renderView(
      state({
        account: {
          ...CONNECTED,
          accounts: [
            account({ needsReconnect: true }),
            account({ id: 'acc-2', email: 'work@gmail.com' }),
          ],
        },
      }),
    )
    openSetup()
    fireEvent.click(screen.getByLabelText('Аккаунт Google'))

    expect(
      screen.getByRole('option', { name: /author@gmail.com — нужно переподключить/i }),
    ).toBeTruthy()
    expect(screen.getByRole('option', { name: 'work@gmail.com' })).toBeTruthy()
  })

  // ⚠ Поломка ЛИСТА про переподключение не говорит: связка краснеет и от правки
  // шапки автором, а переподключение аккаунта её не лечит — совет был бы враньём.
  // У беды листа свой блок с «Вариантами исправления».
  it('сломанная раскладка листа не советует переподключать аккаунт', () => {
    renderView(
      state({
        account: CONNECTED,
        connections: [
          conn({
            status: 'broken',
            lastError: 'Колонки листа больше не совпадают с вопросами формы.',
          }),
        ],
      }),
    )
    openConnection()

    expect(screen.queryByText(/доступ к этому аккаунту потерян/i)).toBeNull()
    // Причина при этом названа — молчать окно не стало.
    expect(
      screen
        .getAllByRole('alert')
        .some((el) => /не совпадают с вопросами/i.test(el.textContent ?? '')),
    ).toBe(true)
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
  it('перезапись спрашивает подтверждение, называет цену и закрывает окно', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(new Response(null, { status: 202 }))
    })
    // Перезалив живёт ВНУТРИ предупреждения: у работающей связки его нет вовсе.
    renderView(
      state({
        account: CONNECTED,
        connections: [conn({ name: 'Архив', status: 'broken', lastError: 'Колонки листа…' })],
      }),
    )
    openConnection()
    fireEvent.click(screen.getByRole('button', { name: /перезаписать лист/i }))

    // Цена названа: чистится ВЕСЬ лист, включая колонки автора.
    expect(screen.getByText(/включая колонки, которые вы добавили в него сами/i)).toBeTruthy()

    // Именно точное имя: рядом стоит кнопка «Перезалить лист», открывшая диалог.
    fireEvent.click(screen.getByRole('button', { name: /^Перезаписать$/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/refill') && c.init?.method === 'POST')).toBe(true),
    )
    // Согласился — уводим из настроек: перезапись начала работу над листом, и
    // держать человека в окне, где нечего больше настраивать, незачем.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    vi.unstubAllGlobals()
  })

  // Раскладку ломает правка ЛИСТА, а лист — чужая территория: поправив шапку
  // обратно, человек не имеет способа сказать нам об этом. Без кнопки ему
  // оставалось бы ждать следующего ответа респондента, чтобы узнать, помогло ли.
  it('«Обновить статус» перепроверяет лист', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(new Response(null, { status: 204 }))
    })
    renderView(
      state({
        account: CONNECTED,
        connections: [conn({ status: 'broken', lastError: 'Колонки листа…' })],
      }),
    )
    openConnection()
    fireEvent.click(screen.getByRole('button', { name: /обновить статус/i }))

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/recheck') && c.init?.method === 'POST')).toBe(true),
    )
    vi.unstubAllGlobals()
  })

  // «Не помогло» — ответ по существу, а не сбой, и говорится он у самой кнопки:
  // уехав вниз, к ошибкам сохранения, он потерял бы связь с нажатием.
  it('перепроверка не помогла — так и сказано у кнопки', async () => {
    const broken = state({
      account: CONNECTED,
      connections: [conn({ status: 'broken', lastError: 'Колонки листа…' })],
    })
    // Отказом отвечает ТОЛЬКО перепроверка: она инвалидирует состояние формы, и
    // если валить заодно его, экран уйдёт в «не удалось загрузить» — проверять
    // будет нечего.
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        String(url).endsWith('/recheck')
          ? new Response(
              JSON.stringify({ error: { code: 'validation_failed', message: 'Колонки…' } }),
              { status: 422, headers: { 'Content-Type': 'application/json' } },
            )
          : new Response(JSON.stringify(broken), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
      ),
    )
    renderView(broken)
    openConnection()
    fireEvent.click(screen.getByRole('button', { name: /обновить статус/i }))

    await waitFor(() => expect(screen.getByText(/пока не сходится/i)).toBeTruthy())

    // И не роняет соседнюю кнопку на строку ниже: строка отказа идёт ПОД рядом,
    // а не элементом в нём — иначе её ширина ломает раскладку ряда.
    const row = screen.getByRole('button', { name: /обновить статус/i }).parentElement
    expect(row?.contains(screen.getByRole('button', { name: /перезаписать лист/i }))).toBe(true)
    expect(row?.contains(screen.getByText(/пока не сходится/i))).toBe(false)
    vi.unstubAllGlobals()
  })

  // Текст предупреждения перечисляет выходы, а не советует «верните как было»:
  // тот совет был без продолжения — сделать можно, а узнать, помогло ли, нечем.
  it('предупреждение называет три выхода', () => {
    renderView(
      state({
        account: CONNECTED,
        connections: [conn({ status: 'broken', lastError: 'Колонки листа…' })],
      }),
    )
    openConnection()

    // По пунктам списка, а не по тексту вообще: «перезаписать лист» есть и на
    // кнопке рядом, и поиск по странице находит оба.
    const exits = screen.getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(screen.getByText('Варианты исправления')).toBeTruthy()
    expect(exits.some((t) => /вернуть заголовки/i.test(t))).toBe(true)
    expect(exits.some((t) => /выбрать другую таблицу или лист/i.test(t))).toBe(true)
    expect(exits.some((t) => /перезаписать лист/i.test(t))).toBe(true)
  })

  // Перезалив — часть предупреждения, а не самостоятельная кнопка: там, где
  // предупреждения нет, нет и его.
  it('у работающей и переносящей связки перезалива на экране нет', () => {
    renderView(state({ account: CONNECTED, connections: [conn()] }))
    openConnection()
    expect(screen.queryByRole('button', { name: /перезаписать лист/i })).toBeNull()
    cleanup()

    renderView(state({ account: CONNECTED, connections: [conn({ status: 'backfilling' })] }))
    openConnection()
    expect(screen.queryByRole('button', { name: /перезаписать лист/i })).toBeNull()
  })

  // Человек уже выбрал другой лист — связка переезжает, и прежняя беда перестаёт
  // быть её делом. Красный блок здесь не просто лишний: в нём стоит «Перезалить
  // лист», а перезалив чистит СТАРЫЙ лист — тот самый, который человек покидает.
  it('выбрал другую цель — предупреждение и перезалив уходят', () => {
    renderView(
      state({
        account: CONNECTED,
        connections: [
          conn({
            name: 'Архив',
            spreadsheetId: 'ss-old',
            status: 'broken',
            lastError: 'Колонки листа…',
          }),
        ],
      }),
    )
    openConnection()
    expect(screen.getByRole('button', { name: /перезаписать лист/i })).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Таблица'))
    fireEvent.click(screen.getByRole('option', { name: /создать новую таблицу/i }))

    expect(screen.queryByRole('button', { name: /перезаписать лист/i })).toBeNull()
    expect(screen.queryByText(/Колонки листа/)).toBeNull()
  })

  // Значок у предупреждения: красный текст в рамке легко принять за подпись поля,
  // а треугольник читается сигналом до того, как текст прочитан.
  it('предупреждение помечено значком', () => {
    renderView(
      state({
        account: CONNECTED,
        connections: [conn({ status: 'broken', lastError: 'Колонки листа…' })],
      }),
    )
    openConnection()

    const alert = screen
      .getAllByRole('alert')
      .find((el) => /Колонки листа/.test(el.textContent ?? ''))
    expect(alert?.querySelector('svg')).toBeTruthy()
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
        <TooltipProvider>
          <IntegrationsView formId={FORM_ID} />
        </TooltipProvider>
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

  // Окно отвечает на «куда лить», а не «как идут дела»: рассказа о процессе в нём
  // нет вовсе. Состояние живёт на точке в списке — там оно видно, не открывая
  // окна, и держать его в двух местах значило бы однажды их рассинхронизировать.
  it('о процессе окно правки не рассказывает', () => {
    renderView(state({ account: CONNECTED, connections: [conn({ status: 'backfilling' })] }))
    openConnection()

    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.queryByText(/переносим ответы/i)).toBeNull()
    // Поломка — исключение: это не отчёт о процессе, а препятствие плюс выход.
    cleanup()
    renderView(
      state({
        account: CONNECTED,
        connections: [conn({ status: 'broken', lastError: 'Колонки листа…' })],
      }),
    )
    openConnection()
    expect(screen.getByRole('button', { name: /перезаписать лист/i })).toBeTruthy()
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

// Значки строки — группа обслуживания связки: стоят вплотную и каждый называет
// себя подсказкой. Подпись одна на кнопку и подсказку: живи она только в
// aria-label, её читал бы скринридер и не видел глаз.
describe('значки в строке связки', () => {
  it('у значка есть подсказка с той же подписью, что и доступное имя', async () => {
    renderView(state({ account: CONNECTED, connections: [conn()] }))

    fireEvent.focus(screen.getByRole('button', { name: 'Журнал доставок' }))

    // getAllByText: Radix рисует к подсказке ещё и скрытую копию для чтения вслух.
    await waitFor(() => expect(screen.getAllByText('Журнал доставок').length).toBeGreaterThan(0))
  })

  it('значки лежат одной коробкой, тумблер в неё не входит', () => {
    renderView(state({ account: CONNECTED, connections: [conn()] }))

    const journal = screen.getByRole('button', { name: 'Журнал доставок' })
    const box = journal.parentElement
    if (!box) throw new Error('у значка нет коробки')
    // Три значка рядом и ничего кроме: тумблер про состояние, а не про действие.
    expect(box.querySelectorAll('button')).toHaveLength(3)
    expect(within(box).queryByRole('switch')).toBeNull()
  })
})

// Журнал доставок — вход из строки связки. Проверяется то, ради чего он заведён:
// человек видит, что стало с КАЖДЫМ ответом, а не только причину последней беды.
describe('журнал доставок', () => {
  // seedLog кладёт готовую ленту в кеш: окно проверяется по содержимому, а не по
  // транспорту (живой fetch в happy-dom падает на ECONNREFUSED).
  function seedLog(qc: ReturnType<typeof renderView>, deliveries: unknown[]) {
    qc.setQueryData(integrationKeys.deliveries(FORM_ID, 'conn-1'), {
      pages: [{ deliveries, nextCursor: undefined }],
      pageParams: [undefined],
    })
  }

  function openLog() {
    fireEvent.click(screen.getByRole('button', { name: 'Журнал доставок' }))
  }

  const delivered = {
    id: 'd-1',
    kind: 'submission',
    submissionId: 's-1',
    outcome: 'delivered',
    rows: 1,
    createdAt: '2026-09-09T10:00:00Z',
  }
  const failed = {
    id: 'd-2',
    kind: 'submission',
    submissionId: 's-2',
    outcome: 'failed',
    detail: 'Записать в таблицу не удалось, попробуем ещё раз позже.',
    rows: 0,
    createdAt: '2026-09-09T11:00:00Z',
  }

  it('лента показывает исход каждой попытки и причину неудачи', () => {
    const qc = renderView(state({ account: CONNECTED, connections: [conn()] }))
    seedLog(qc, [failed, delivered])
    openLog()

    expect(screen.getByText('Журнал доставок')).toBeTruthy()
    expect(screen.getByText('Ответ записан в таблицу')).toBeTruthy()
    expect(screen.getByText('Ответ не записан')).toBeTruthy()
    // Причина стоит текстом, а не прячется в тултип: за ней журнал и открывают.
    expect(screen.getByText(/попробуем ещё раз позже/i)).toBeTruthy()
  })

  it('«Повторить» стоит у неудачи и не стоит у успеха', () => {
    const qc = renderView(state({ account: CONNECTED, connections: [conn()] }))
    seedLog(qc, [failed, delivered])
    openLog()

    // Ровно одна кнопка на две строки — у той, где есть что повторять: запись в
    // лист не идемпотентна, и повтор успеха положил бы ответ вторым разом.
    expect(screen.getAllByRole('button', { name: /Повторить/ })).toHaveLength(1)
  })

  it('у сломанной связки повтора нет: сначала починка', () => {
    const qc = renderView(
      state({
        account: CONNECTED,
        connections: [conn({ status: 'broken', lastError: 'нет доступа' })],
      }),
    )
    seedLog(qc, [failed])
    openLog()

    expect(screen.getByText('Ответ не записан')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Повторить/ })).toBeNull()
  })

  it('доставок не было — окно говорит об этом, а не показывает пустоту', () => {
    const qc = renderView(state({ account: CONNECTED, connections: [conn()] }))
    seedLog(qc, [])
    openLog()

    expect(screen.getByText('Доставок пока не было')).toBeTruthy()
  })
})

// hook — вебхук в состоянии «работает», если не сказано иное.
function hook(patch: Partial<Webhook> = {}): Webhook {
  return {
    id: 'hook-1',
    name: 'CRM',
    host: 'hooks.zapier.com',
    url: 'https://hooks.zapier.com/hooks/catch/1/SECRETPATH',
    signed: false,
    headers: [],
    enabled: true,
    status: 'live',
    queued: 0,
    ...patch,
  }
}

describe('вебхуки на экране интеграций', () => {
  it('каталог предлагает вебхук отдельной плиткой', () => {
    renderView(state())

    expect(screen.getByText('Вебхук')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Подключить вебхук' })).toBeTruthy()
  })

  it('строка вебхука показывает ХОСТ, а не адрес целиком', () => {
    renderView(state({ webhooks: [hook()] }))

    expect(screen.getByText(/hooks\.zapier\.com/)).toBeTruthy()
    // Путь адреса — секрет (у Zapier и Make в нём токен): в списке его нет.
    expect(document.body.textContent).not.toContain('SECRETPATH')
  })

  it('очередь названа, когда она есть', () => {
    renderView(state({ webhooks: [hook({ queued: 3 })] }))

    expect(screen.getByText(/в очереди 3/)).toBeTruthy()
  })

  it('сломанный вебхук говорит причиной, а не общей фразой', () => {
    renderView(
      state({
        webhooks: [
          hook({ status: 'broken', lastError: 'Получатель сообщил, что этого адреса больше нет.' }),
        ],
      }),
    )

    expect(screen.getByRole('button', { name: 'Сломано' })).toBeTruthy()
  })

  it('тумблер строки шлёт правку, не трогая адрес', async () => {
    // Считаем только правки: после мутации экран перезапрашивает состояние
    // формы, и её GET попал бы в тот же счётчик.
    const calls: { url: string; body: unknown }[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined })
      }
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    renderView(state({ webhooks: [hook()] }))

    fireEvent.click(screen.getByRole('switch', { name: 'Выключить вебхук' }))

    await waitFor(() => expect(calls.length).toBe(1))
    const patch = calls[0]!
    expect(patch.url).toContain('/forms/form-1/webhooks/hook-1')
    expect(patch.body).toEqual({ enabled: false })
    vi.unstubAllGlobals()
  })

  it('удаление спрашивает и обещает сохранить сами ответы', () => {
    renderView(state({ webhooks: [hook()] }))

    fireEvent.click(screen.getByRole('button', { name: 'Удалить вебхук' }))

    expect(screen.getByText('Удалить вебхук?')).toBeTruthy()
    expect(screen.getByText(/сами ответы формы останутся на месте/)).toBeTruthy()
  })

  it('окно подключения — адрес, название и ПРЕДЛОЖЕНИЕ подписи, но не поле', () => {
    renderView(state())

    fireEvent.click(screen.getByRole('button', { name: 'Подключить вебхук' }))

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText('Адрес получателя')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Подключить' })).toBeTruthy()
    // Подпись предлагается сразу — но кнопкой: поля секрета до нажатия нет, и
    // человек, который цепляет Zapier, ничего никуда не вставляет.
    expect(screen.getByRole('button', { name: 'Подписывать запросы' })).toBeTruthy()
    expect(screen.queryByLabelText('Секрет подписи')).toBeNull()
    // Проверять нечего: адрес ещё не сохранён.
    expect(screen.queryByRole('button', { name: 'Проверить' })).toBeNull()
  })

  it('предложение подписи — кнопка, и она открывает поле секрета', () => {
    renderView(state())
    fireEvent.click(screen.getByRole('button', { name: 'Подключить вебхук' }))

    // Тумблера у подписи нет: включение требует ввести секрет, а тумблер обещал
    // бы мгновенное действие.
    expect(screen.queryByRole('switch', { name: 'Подписывать запросы' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Подписывать запросы' }))

    expect(screen.getByLabelText('Секрет подписи')).toBeTruthy()
    expect(screen.getByText(/Trillix-Signature/)).toBeTruthy()
    // Передумал — поле уходит, предложение возвращается.
    fireEvent.click(screen.getByRole('button', { name: 'Без подписи' }))
    expect(screen.queryByLabelText('Секрет подписи')).toBeNull()
    expect(screen.getByRole('button', { name: 'Подписывать запросы' })).toBeTruthy()
  })

  it('окно настройки: адрес в поле, проверка рядом, подпись не включена', () => {
    renderView(state({ webhooks: [hook()] }))

    fireEvent.click(screen.getByRole('button', { name: 'Настроить вебхук' }))

    const url = screen.getByLabelText('Адрес получателя') as HTMLInputElement
    expect(url.value).toBe('https://hooks.zapier.com/hooks/catch/1/SECRETPATH')
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeTruthy()
    // Подпись не включена — полей о секрете нет вовсе, только предложение.
    expect(screen.getByRole('button', { name: 'Подписывать запросы' })).toBeTruthy()
    expect(screen.queryByLabelText('Секрет подписи')).toBeNull()
  })

  it('у подписанного вебхука поле пустое, а показ действующего — не смена', async () => {
    const calls = mockWebhookCalls(state({ webhooks: [hook({ signed: true })] }), {
      secret: 'общий-секрет-на-все-формы',
    })
    renderView(state({ webhooks: [hook({ signed: true })] }))

    fireEvent.click(screen.getByRole('button', { name: 'Настроить вебхук' }))

    // Секрет в состоянии таба не приезжает: поле пустое, и пустое значит
    // «не менять».
    const field = screen.getByLabelText('Секрет подписи') as HTMLInputElement
    expect(field.value).toBe('')
    expect(screen.getByText(/Trillix-Signature/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Показать' }))
    await waitFor(() => expect(field.value).toBe('общий-секрет-на-все-формы'))

    // Посмотрел и сохранил — секрет не переписывается тем же значением: у
    // получателя смена ломает проверку, и делать её «заодно с показом» нельзя.
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.map((c) => c.method)).toEqual(['PATCH'])
    vi.unstubAllGlobals()
  })
  it('подключение закрывает окно и не шлёт ничего про секрет', async () => {
    const posts: { url: string; body: unknown }[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/integrations')) {
        return new Response(JSON.stringify(state()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (init?.method === 'POST') {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
        return new Response(
          JSON.stringify({
            id: 'hook-new',
            host: 'hooks.example.com',
            url: 'https://hooks.example.com/x',
            signed: false,
            enabled: true,
            status: 'live',
            queued: 0,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    renderView(state())
    fireEvent.click(screen.getByRole('button', { name: 'Подключить вебхук' }))

    fireEvent.change(screen.getByLabelText('Адрес получателя'), {
      target: { value: 'https://hooks.example.com/x' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }))

    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0]!.body).toEqual({ name: '', url: 'https://hooks.example.com/x' })
    // Окно закрылось: человек вернулся к списку, а не получил второй экран.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    vi.unstubAllGlobals()
  })

  it('подпись включают ПРЯМО при подключении: секрет уезжает тем же запросом', async () => {
    const posts: { url: string; body: unknown }[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(state()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (init?.method === 'POST') {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      }
      return new Response(
        JSON.stringify({
          id: 'hook-new',
          host: 'hooks.example.com',
          url: 'https://hooks.example.com/x',
          signed: true,
          enabled: true,
          status: 'live',
          queued: 0,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    renderView(state())
    fireEvent.click(screen.getByRole('button', { name: 'Подключить вебхук' }))

    fireEvent.change(screen.getByLabelText('Адрес получателя'), {
      target: { value: 'https://hooks.example.com/x' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Подписывать запросы' }))
    // Короткий секрет обесценил бы подпись — подключиться с ним нельзя.
    fireEvent.change(screen.getByLabelText('Секрет подписи'), { target: { value: '123456' } })
    expect((screen.getByRole('button', { name: 'Подключить' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    fireEvent.change(screen.getByLabelText('Секрет подписи'), {
      target: { value: 'общий-секрет-на-все-формы' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }))

    // Один запрос, а не «завести, потом включить подпись».
    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0]!.body).toEqual({
      name: '',
      url: 'https://hooks.example.com/x',
      secret: 'общий-секрет-на-все-формы',
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    vi.unstubAllGlobals()
  })

  it('в настройках одно «Сохранить» шлёт и правку, и секрет', async () => {
    const calls = mockWebhookCalls(state({ webhooks: [hook({ signed: true })] }))
    renderView(state({ webhooks: [hook({ signed: true })] }))
    fireEvent.click(screen.getByRole('button', { name: 'Настроить вебхук' }))

    fireEvent.change(screen.getByLabelText('Секрет подписи'), {
      target: { value: 'общий-секрет-на-все-формы' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(calls.length).toBe(2))
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[1]!.method).toBe('POST')
    expect(calls[1]!.url).toContain('/webhooks/hook-1/secret')
    expect(calls[1]!.body).toEqual({ secret: 'общий-секрет-на-все-формы' })
    // Второй кнопки «Сохранить секрет» нет: окно закрывается одним нажатием.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    vi.unstubAllGlobals()
  })

  it('пустое поле секрета у подписанного вебхука его НЕ меняет', async () => {
    const calls = mockWebhookCalls(state({ webhooks: [hook({ signed: true })] }))
    renderView(state({ webhooks: [hook({ signed: true })] }))
    fireEvent.click(screen.getByRole('button', { name: 'Настроить вебхук' }))

    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls.map((c) => c.method)).toEqual(['PATCH'])
    vi.unstubAllGlobals()
  })

  it('свои заголовки предлагаются кнопкой, полей до нажатия нет', () => {
    renderView(state())
    fireEvent.click(screen.getByRole('button', { name: 'Подключить вебхук' }))

    expect(screen.getByRole('button', { name: 'Свои заголовки' })).toBeTruthy()
    expect(screen.queryByLabelText('Имя заголовка 1')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Свои заголовки' }))
    expect(screen.getByLabelText('Имя заголовка 1')).toBeTruthy()
    expect(screen.getByLabelText('Значение заголовка 1')).toBeTruthy()

    // Передумал — строки уходят, предложение возвращается.
    fireEvent.click(screen.getByRole('button', { name: 'Без заголовков' }))
    expect(screen.queryByLabelText('Имя заголовка 1')).toBeNull()
    expect(screen.getByRole('button', { name: 'Свои заголовки' })).toBeTruthy()
  })

  it('заголовки уезжают вместе с подключением, значение без имени его не даёт', async () => {
    const posts: { url: string; body: unknown }[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(state()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify(hook({ id: 'hook-new' })), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    renderView(state())
    fireEvent.click(screen.getByRole('button', { name: 'Подключить вебхук' }))

    fireEvent.change(screen.getByLabelText('Адрес получателя'), {
      target: { value: 'https://hooks.example.com/x' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Свои заголовки' }))
    // Значение без имени — недописанная строка: отправлять её незачем, сервер
    // всё равно откажет.
    fireEvent.change(screen.getByLabelText('Значение заголовка 1'), {
      target: { value: 'Bearer abc123' },
    })
    expect((screen.getByRole('button', { name: 'Подключить' }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    fireEvent.change(screen.getByLabelText('Имя заголовка 1'), {
      target: { value: 'Authorization' },
    })
    // Вторая строка добавляется и убирается.
    fireEvent.click(screen.getByRole('button', { name: 'Ещё заголовок' }))
    expect(screen.getByLabelText('Имя заголовка 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Убрать заголовок 2' }))
    expect(screen.queryByLabelText('Имя заголовка 2')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }))

    await waitFor(() => expect(posts.length).toBe(1))
    expect(posts[0]!.body).toEqual({
      name: '',
      url: 'https://hooks.example.com/x',
      headers: [{ name: 'Authorization', value: 'Bearer abc123' }],
    })
    vi.unstubAllGlobals()
  })

  it('заголовки заведённого вебхука видны в полях и убираются при сохранении', async () => {
    const withHeaders = hook({ headers: [{ name: 'Authorization', value: 'Bearer abc123' }] })
    const calls = mockWebhookCalls(state({ webhooks: [withHeaders] }))
    renderView(state({ webhooks: [withHeaders] }))
    fireEvent.click(screen.getByRole('button', { name: 'Настроить вебхук' }))

    expect((screen.getByLabelText('Имя заголовка 1') as HTMLInputElement).value).toBe(
      'Authorization',
    )
    expect((screen.getByLabelText('Значение заголовка 1') as HTMLInputElement).value).toBe(
      'Bearer abc123',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Без заголовков' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(calls.length).toBe(1))
    // Пустой список — это «убрать все», а не «не трогать».
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.body).toMatchObject({ headers: [] })
    vi.unstubAllGlobals()
  })

  it('«Без подписи» у подписанного вебхука выключает её при сохранении', async () => {
    const calls = mockWebhookCalls(state({ webhooks: [hook({ signed: true })] }))
    renderView(state({ webhooks: [hook({ signed: true })] }))
    fireEvent.click(screen.getByRole('button', { name: 'Настроить вебхук' }))

    fireEvent.click(screen.getByRole('button', { name: 'Без подписи' }))
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(calls.length).toBe(2))
    expect(calls[1]!.method).toBe('DELETE')
    expect(calls[1]!.url).toContain('/webhooks/hook-1/secret')
    vi.unstubAllGlobals()
  })
})

// mockWebhookCalls подменяет fetch: состояние таба отдаётся настоящим JSON (иначе
// перезапрос после мутации подменил бы окно экраном отказа), остальное считается.
// secret — что отдать на запрос показа секрета.
function mockWebhookCalls(
  snapshot: unknown,
  opts: { secret?: string } = {},
): { method: string; url: string; body: unknown }[] {
  const calls: { method: string; url: string; body: unknown }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') {
      const body = url.includes('/secret') ? { secret: opts.secret ?? '' } : snapshot
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
  return calls
}
