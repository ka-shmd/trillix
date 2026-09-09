// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'

import { type Block, type FormSchema, SCHEMA_VERSION, textFromString } from '@entities/formSchema'

import { type FormTemplate } from '../../../entities/template'
import { TemplateDialog } from './TemplateDialog'
import { TemplateSheet } from './TemplateSheet'
import { TemplatesView } from './TemplatesView'

// Сторожа на то, что ломается МОЛЧА. Плитка показывает саму форму, и обещание
// «увидишь то же, что получишь» не проверяется ни типами, ни тестом на поведение:
// подмени лист картинкой-заглушкой — экран продолжит работать, а обещание исчезнет.
// Второе такое место — `inert` на миниатюре: без него каждая плитка приводит тому,
// кто ходит табом, семь полей, в которые нельзя писать. Третье — провайдеры `@fields`
// на листе: шаблон теперь снят с ЖИВОЙ формы, и в нём бывает всё, что автор поставил
// на полотно.

const FIELD = 'blk_name'

// Документ публичного шаблона: заголовок формы, вопрос с подписью, подстановка
// ответа в подписи второго вопроса и запись на время. Последние два — ровно то,
// чего у встроенных шаблонов не бывало и что приезжает из живой формы.
const blocks: Block[] = [
  { id: 'blk_h', groupId: 'grp_h', type: 'form_title', text: textFromString('Обратная связь') },
  { id: 'blk_c1', groupId: 'grp_1', type: 'title', text: textFromString('Как вас зовут?') },
  { id: FIELD, groupId: 'grp_1', type: 'short_text' },
  {
    id: 'blk_c2',
    groupId: 'grp_2',
    type: 'title',
    text: [{ t: 'Когда вам удобно, ' }, { t: 'ваше имя', ref: FIELD }, { t: '?' }],
  },
  { id: 'blk_slot', groupId: 'grp_2', type: 'slot' },
]

const PUBLIC = {
  id: 'tpl-public',
  title: 'Обратная связь',
  description: 'Заготовка сервиса',
  schema: { schemaVersion: SCHEMA_VERSION, blocks },
  visibility: 'public',
  workspaceId: null,
}

const OWN = {
  id: 'tpl-own',
  title: 'Бриф студии',
  description: 'Наш шаблон пространства',
  schema: {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      { id: 'blk_h2', groupId: 'grp_h2', type: 'form_title', text: textFromString('Бриф студии') },
      { id: 'blk_c3', groupId: 'grp_3', type: 'title', text: textFromString('Что за проект?') },
      { id: 'blk_f3', groupId: 'grp_3', type: 'long_text' },
    ],
  },
  visibility: 'private',
  workspaceId: 'ws-1',
}

const CREATED = { id: 'f-1', slug: 'obratnaya-svyaz', title: 'Обратная связь' }

let calls: string[] = []

function json(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      if (method === 'GET') return json({ items: [PUBLIC, OWN] })
      if (url.endsWith('/use')) return json(CREATED)
      return Promise.resolve(new Response(null, { status: 204 }))
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Галерея заводит форму и уводит в редактор, поэтому живёт внутри роутера — как и
// в кабинете.
async function renderGallery() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <TemplatesView workspaceId="ws-1" workspaceSlug="team" />
        <Outlet />
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/w/$workspaceSlug/templates', '/w/$workspaceSlug/forms/$slug/edit'].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ['/w/team/templates'] }),
  })
  render(<RouterProvider router={router as never} />)
  await act(async () => {
    await router.load()
  })
  await screen.findByRole('button', { name: `Посмотреть шаблон «${PUBLIC.title}»` })
  return router
}

// Плитка ищется по своей растянутой кнопке: у карточки нет ни роли, ни имени, а
// кнопка называет шаблон словами (она же — единственный способ его открыть).
function tileOf(title: string): HTMLElement {
  return screen.getByRole('button', { name: `Посмотреть шаблон «${title}»` }).parentElement!
}

it('галерея берёт шаблоны с сервера — одним запросом, с пространством в адресе', async () => {
  await renderGallery()

  expect(calls).toEqual(['GET /api/v1/templates?workspaceId=ws-1'])
})

it('плитка показывает саму форму, а не рассказ о ней', async () => {
  await renderGallery()
  const tile = tileOf(PUBLIC.title)

  // Заголовок формы и её вопросы стоят в плитке разметкой полотна (rf-*), а не
  // строчками списка: подмена листа заглушкой уронит этот тест.
  expect(tile.querySelector('.rf-page')).not.toBeNull()
  expect(within(tile).getAllByText('Как вас зовут?').length).toBeGreaterThan(0)
})

it('лист надевает провайдеры @fields — запись рисуется, подстановка не выдаёт имя вопроса', async () => {
  await renderGallery()
  const tile = tileOf(PUBLIC.title)

  // МИНА. Без SlotStubProvider вопрос записи нарисовался бы пустотой, без
  // MentionContext подстановка `@` — именем вопроса («ваше имя») вместо ответа.
  // Оба отказа тихие: экран продолжает работать, показывая не ту форму.
  expect(tile.querySelector('.rf-slots--stub')).not.toBeNull()
  expect(within(tile).queryByText(/ваше имя/)).toBeNull()
})

it('контролы листа не disabled — иначе показывался бы не тот вид', async () => {
  await renderGallery()

  // `disabled` — не «то же самое, но нельзя трогать»: `.rf-submit:disabled` гасит
  // кнопку до половинной прозрачности, а `.rf-input:disabled` подставляет полю
  // прозрачный фон вместо `--rf-field-bg` (TD-73). То есть ровно тот вид, который
  // галерея обещает показать, disabled и подменяет. Неинтерактивность держит `inert`
  // на коробке миниатюры, а не запрет на контролах.
  const sheet = document.querySelector('.tpl-sheet')!
  for (const control of Array.from(sheet.querySelectorAll('input, textarea, select, button'))) {
    expect(control.hasAttribute('disabled')).toBe(false)
  }
})

it('миниатюра inert — поля формы не забирают табы и не звучат у диктора', async () => {
  await renderGallery()
  const thumb = document.querySelector('.tpl-thumb')!
  expect(thumb.hasAttribute('inert')).toBe(true)
  expect(thumb.getAttribute('aria-hidden')).toBe('true')
})

it('вкладки разводят витрину и шаблоны пространства', async () => {
  await renderGallery()

  // Первой стоит витрина: своих шаблонов у нового пространства нет.
  expect(screen.queryByRole('button', { name: `Посмотреть шаблон «${OWN.title}»` })).toBeNull()

  // Вкладка переключается нажатием мыши, а не click(): Radix слушает mousedown.
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Мои' }))

  await screen.findByRole('button', { name: `Посмотреть шаблон «${OWN.title}»` })
  expect(screen.queryByRole('button', { name: `Посмотреть шаблон «${PUBLIC.title}»` })).toBeNull()
  // Удаление есть только у своего: витрина правится там же, где заводится.
  expect(screen.getByRole('button', { name: `Действия с шаблоном «${OWN.title}»` })).toBeTruthy()
})

it('нажатие на плитку открывает просмотр, оттуда заводится форма', async () => {
  const router = await renderGallery()
  fireEvent.click(screen.getByRole('button', { name: `Посмотреть шаблон «${PUBLIC.title}»` }))

  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(PUBLIC.description)).toBeTruthy()
  // Окно называет, сколько вопросов получит автор: отвечаемых блоков документа
  // (поле имени и запись), а не всех подряд.
  expect(within(dialog).getByText(/^2\s/)).toBeTruthy()

  fireEvent.click(within(dialog).getByRole('button', { name: 'Использовать шаблон' }))

  // ОДИН запрос, а не пара «создать форму + записать черновик»: сорванный второй
  // оставлял бы на дашборде пустую форму.
  await waitFor(() =>
    expect(calls).toEqual([
      'GET /api/v1/templates?workspaceId=ws-1',
      'POST /api/v1/templates/tpl-public/use',
    ]),
  )
  // И уводит в редактор заведённой формы — по slug из ответа.
  await waitFor(() =>
    expect(router.state.location.pathname).toBe('/w/team/forms/obratnaya-svyaz/edit'),
  )
})

// КНОПКА ПЕРВОГО ЭКРАНА — сторож на молчаливое расхождение галереи с формой. Лист
// показывает ОДНУ страницу, и кнопка под ней обязана быть той, что увидит респондент:
// у многостраничной формы это переход, а не отправка. Отправка на первом экране
// обещает форму из одного шага — а шаблон берут именно по этому обещанию.
const sheet = (blocks: Block[], submitLabel?: string): FormSchema => ({
  schemaVersion: SCHEMA_VERSION,
  blocks,
  ...(submitLabel === undefined ? {} : { submitLabel }),
})

const pageOne: Block[] = [
  { id: 'p1_c', groupId: 'g1', type: 'title', text: textFromString('Как вас зовут?') },
  { id: 'p1_f', groupId: 'g1', type: 'short_text' },
]
const pageTwo: Block[] = [
  { id: 'p2_c', groupId: 'g2', type: 'title', text: textFromString('Почта') },
  { id: 'p2_f', groupId: 'g2', type: 'email' },
]
const stepButton = (container: HTMLElement) => container.querySelector('.rf-submit')!

it('первый экран многостраничного шаблона ведёт переходом, а не отправкой', () => {
  const { container } = render(
    <TemplateSheet
      schema={sheet(
        [
          ...pageOne,
          { id: 'brk', groupId: '', type: 'page_break', settings: { nextLabel: 'Дальше' } },
          ...pageTwo,
        ],
        'Записаться',
      )}
    />,
  )
  const btn = stepButton(container)
  expect(btn.textContent).toBe('Дальше')
  expect(btn.classList.contains('rf-next')).toBe(true)
})

it('без подписи автора переход подписан дефолтом', () => {
  const { container } = render(
    <TemplateSheet
      schema={sheet([...pageOne, { id: 'brk', groupId: '', type: 'page_break' }, ...pageTwo])}
    />,
  )
  expect(stepButton(container).textContent).toBe('Далее')
})

// Разрыв последним блоком второй страницы не открывает (splitPagesWithClosers), то есть
// форма остаётся одностраничной — и кнопка на ней отправляет. Считать многостраничность
// по наличию закрывающего разрыва здесь было бы ошибкой.
it('разрыв в конце документа не превращает отправку в переход', () => {
  const { container } = render(
    <TemplateSheet
      schema={sheet([...pageOne, { id: 'brk', groupId: '', type: 'page_break' }], 'Записаться')}
    />,
  )
  const btn = stepButton(container)
  expect(btn.textContent).toBe('Записаться')
  expect(btn.classList.contains('rf-next')).toBe(false)
})

// ЛИСТАНИЕ ЖИВЁТ В ОКНЕ, А НЕ В ЛИСТЕ (решение владельца 2026-09-09). Кнопки «Далее» и
// «Отправить» принадлежат форме и стоят внутри листа; «Назад» и номер страницы форме не
// принадлежат — у респондента их нет — и стоят в подвале окна. Поэтому и проверяется ход
// через окно: у листа своей памяти больше нет, он рисует тот экран, который ему назвали.
const titled: Block[] = [
  { id: 'tpl_h', groupId: 'gh', type: 'form_title', text: textFromString('Заявка') },
  ...pageOne,
]
const twoPages = (extra: Block[] = []): Block[] => [
  ...titled,
  { id: 'brk', groupId: '', type: 'page_break', settings: { nextLabel: 'Дальше' } },
  ...pageTwo,
  ...extra,
]

// Окно рисуется в портале, поэтому ищем по документу, а не по контейнеру рендера.
const stepBtn = () => document.querySelector<HTMLButtonElement>('.rf-submit')!
const field = () => document.querySelector<HTMLInputElement>('.rf-input')!

function openWalk(blocks: Block[], submitLabel?: string) {
  const template: FormTemplate = {
    id: 'tpl-walk',
    title: 'Проба',
    description: 'шаблон с разрывом',
    schema: sheet(blocks, submitLabel),
    visibility: 'public',
    workspaceId: null,
  }
  return render(
    <TemplateDialog
      template={template}
      onOpenChange={() => {}}
      onUse={() => {}}
      pending={false}
      failed={false}
    />,
  )
}

it('в окне «Далее» уводит на вторую страницу — без хрома и с отправкой', () => {
  openWalk(twoPages(), 'Записаться')
  expect(screen.getByText('Заявка')).toBeTruthy()

  fireEvent.click(stepBtn())

  expect(screen.getByText('Почта')).toBeTruthy()
  expect(screen.queryByText('Как вас зовут?')).toBeNull()
  // Заголовок формы — хром первого экрана: на второй странице его у респондента нет.
  expect(screen.queryByText('Заявка')).toBeNull()
  expect(stepBtn().textContent).toBe('Записаться')
  expect(stepBtn().classList.contains('rf-next')).toBe(false)
})

it('«Назад» окна возвращает на страницу и не теряет ответ', () => {
  openWalk(twoPages())
  fireEvent.change(field(), { target: { value: 'Кирилл' } })
  fireEvent.click(stepBtn())
  fireEvent.click(screen.getByRole('button', { name: /Назад/ }))

  expect(screen.getByText('Как вас зовут?')).toBeTruthy()
  expect(field().value).toBe('Кирилл')
})

// «Назад» и номер — В ПОДВАЛЕ ОКНА, а не внутри формы. Сторож на возврат их в лист:
// внутри `.rf-page` они выдавали бы себя за контролы формы, которых у респондента нет.
it('обратный ход и номер страницы стоят вне листа формы', () => {
  openWalk(twoPages())
  fireEvent.click(stepBtn())
  const back = screen.getByRole('button', { name: /Назад/ })
  expect(back.closest('.rf-page')).toBeNull()
  expect(screen.getByText('Страница 2 из 2').closest('.rf-page')).toBeNull()
})

it('номер страницы говорит, где автор и сколько всего', () => {
  openWalk(twoPages())
  expect(screen.getByText('Страница 1 из 2')).toBeTruthy()
  fireEvent.click(stepBtn())
  expect(screen.getByText('Страница 2 из 2')).toBeTruthy()
})

it('у одностраничного шаблона номера страницы нет вовсе', () => {
  openWalk(pageOne)
  expect(screen.queryByText(/Страница \d+ из/)).toBeNull()
  expect(screen.queryByRole('button', { name: /Назад/ })).toBeNull()
})

it('отправка показывает страницу «Спасибо» шаблона', () => {
  const thanks: Block[] = [
    { id: 'brkTY', groupId: '', type: 'page_break', settings: { thankYou: true } },
    { id: 'ty_h', groupId: 'gty', type: 'heading', text: textFromString('Ждём вас!') },
  ]
  openWalk(twoPages(thanks))
  // Страница «Спасибо» не шаг: страниц по-прежнему две.
  expect(screen.getByText('Страница 1 из 2')).toBeTruthy()
  fireEvent.click(stepBtn())
  fireEvent.click(stepBtn())
  expect(screen.getByText('Ждём вас!')).toBeTruthy()
  // Экран после отправки — не страница формы, номера у него нет.
  expect(screen.queryByText(/Страница \d+ из/)).toBeNull()
})

it('без страницы «Спасибо» отправка говорит, что будет у формы, а не молчит', () => {
  openWalk(twoPages())
  fireEvent.click(stepBtn())
  fireEvent.click(stepBtn())
  expect(screen.getByText(/Экран после отправки в этом шаблоне не собран/)).toBeTruthy()
})

it('плитка не листается: «Далее» не уводит со страницы', () => {
  const { container } = render(<TemplateSheet schema={sheet(twoPages())} />)
  fireEvent.click(stepButton(container))
  expect(screen.getByText('Как вас зовут?')).toBeTruthy()
  expect(stepButton(container).textContent).toBe('Дальше')
})
