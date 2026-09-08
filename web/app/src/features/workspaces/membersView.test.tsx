// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'

import type { Member, PendingInvite } from '../../entities/member'
import type { Workspace } from '../../entities/workspace'
import { WorkspaceAddressProvider } from '../../shared/workspaceContext'
import { planKeys } from '../plan/keys'
import { MembersView } from './MembersView'
import { workspaceKeys } from './keys'

// Сторожа на то, что ломается МОЛЧА: экран продолжает рисоваться, а обещание
// меняется. Два деструктивных действия строки, правило «плоскость вместо рамки» и
// прятанье кнопок по правам невидимы любой проверке типов.

const TEAM: Workspace = {
  id: 'ws-team',
  slug: 'team',
  name: 'Команда',
  isPersonal: false,
  formCount: 0,
  frozen: false,
}

function member(over: Partial<Member> & { userId: string; email: string }): Member {
  return {
    firstName: '',
    lastName: '',
    avatarKey: '',
    role: 'editor',
    joinedAt: '2026-08-01T10:00:00Z',
    ...over,
  }
}

const OWNER = member({ userId: 'u-owner', email: 'owner@example.com', role: 'owner' })
const MATE = member({ userId: 'u-mate', email: 'mate@example.com', firstName: 'Пётр' })

const OWNER_PERMISSIONS = ['member.read', 'member.manage', 'billing.view', 'ownership.transfer']

let calls: string[] = []
const writes = () => calls.filter((c) => !c.startsWith('GET '))

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return Promise.resolve(new Response(null, { status: 204 }))
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Экран берёт пространство из АДРЕСА (usePlanQuota → useCurrentWorkspace), поэтому
// живёт внутри роутера и провайдера адреса — как и в кабинете.
async function renderMembers(opts: {
  members?: Member[]
  invites?: PendingInvite[]
  permissions?: string[]
  // seats — снимок тарифа. Не передан = его в кэше нет вовсе (право не дано либо
  // снимок ещё едет); limit: null = безлимит.
  seats?: { used: number; limit: number | null }
  currentUserId?: string
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  qc.setQueryData(workspaceKeys.list(), [TEAM])
  qc.setQueryData(workspaceKeys.members(TEAM.id), {
    members: opts.members ?? [OWNER],
    invites: opts.invites ?? [],
    permissions: opts.permissions ?? OWNER_PERMISSIONS,
  })
  if (opts.seats) {
    qc.setQueryData(planKeys.snapshot(TEAM.id), {
      planCode: 'free',
      planTitle: 'Бесплатный',
      periodEnd: '2026-10-01',
      features: [
        {
          key: 'members_per_workspace',
          title: 'Участников',
          kind: 'quota',
          allowed: true,
          used: opts.seats.used,
          limit: opts.seats.limit,
        },
      ],
    })
  }

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <WorkspaceAddressProvider personalSlug="personal">
          <MembersView
            workspace={TEAM}
            currentUserId={opts.currentUserId ?? OWNER.userId}
            onLeft={() => {}}
          />
          <Outlet />
        </WorkspaceAddressProvider>
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      ['/w/$workspaceSlug/members', '/settings/plan'].map((path) =>
        createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: ['/w/team/members'] }),
  })
  render(<RouterProvider router={router as never} />)
  await act(async () => {
    await router.load()
  })
}

// Радиксовое меню в тестах открывается Enter'ом на триггере: обычный click оно
// игнорирует — слушает pointer-события, которых happy-dom не диспатчит.
function openRowMenu(name: string) {
  fireEvent.keyDown(screen.getByRole('button', { name: `Действия: ${name}` }), { key: 'Enter' })
}

it('списки строк не обведены рамкой', async () => {
  await renderMembers({ members: [OWNER, MATE] })

  // DESIGN-SYSTEM §7, «Плоскость вместо рамки»: список однородных строк не
  // получает ни рамки, ни подложки. Класс, а не вид: правило невидимо любой
  // проверке поведения, а коробка возвращается копипастой — именно с этого экрана
  // она однажды уехала на аккаунт.
  const [list] = screen.getAllByRole('list')
  if (!list) throw new Error('списка участников на экране нет')
  expect(list.className).toContain('border-t')
  expect(list.className).not.toContain('rounded')
  expect(list.className.split(/\s+/)).not.toContain('border')
})

it('своя строка помечена, человек назван именем, а не адресом', async () => {
  await renderMembers({ members: [OWNER, MATE] })

  expect(screen.getByText('— вы')).toBeTruthy()
  // У кого есть имя — зовётся именем (displayName, одна точка на кабинет), адрес
  // уходит во вторую строку. У безымянного второй строкой стоял бы его дубль.
  expect(screen.getByText('Пётр')).toBeTruthy()
  expect(screen.getByText(/mate@example\.com/)).toBeTruthy()
})

it('владельца снять нельзя: у его строки нет меню действий', async () => {
  await renderMembers({ members: [OWNER, MATE] })

  // Пространство без владельца не имеет плана (TD-53), поэтому пункта нет вовсе,
  // а не «есть и отвечает отказом».
  expect(screen.queryByRole('button', { name: `Действия: ${OWNER.email}` })).toBeNull()
  expect(screen.getByRole('button', { name: 'Действия: Пётр' })).toBeTruthy()
})

it('снятие доступа спрашивает подтверждение до запроса', async () => {
  await renderMembers({ members: [OWNER, MATE] })

  openRowMenu('Пётр')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Снять доступ' }))

  await screen.findByRole('heading', { name: 'Снять доступ: Пётр?' })
  expect(writes()).toEqual([])

  fireEvent.click(screen.getByRole('button', { name: 'Снять доступ' }))
  await waitFor(() => expect(writes()).toEqual(['DELETE /api/v1/workspaces/ws-team/members/u-mate']))
})

it('передача владения называет смену плательщика и ждёт подтверждения', async () => {
  await renderMembers({ members: [OWNER, MATE] })

  openRowMenu('Пётр')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Передать владение' }))

  // Следствия названы ДО нажатия: отыграть их отдающий не сможет — вернуть
  // владение вправе только новый владелец.
  await screen.findByRole('heading', { name: 'Передать владение: Пётр?' })
  expect(screen.getByText(/тарифу этого человека/)).toBeTruthy()
  expect(writes()).toEqual([])

  fireEvent.click(screen.getByRole('button', { name: 'Передать владение' }))
  await waitFor(() => expect(writes()).toEqual(['POST /api/v1/workspaces/ws-team/ownership']))
})

it('приглашают кнопкой и диалогом, поля почты в потоке страницы нет', async () => {
  await renderMembers({ members: [OWNER] })

  // Решение владельца 2026-09-08: исключение из правила «завести новое — кнопкой в
  // заголовке» снято, и поле в потоке страницы не должно вернуться.
  expect(screen.queryByLabelText('Адрес почты')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Пригласить' }))
  await screen.findByRole('dialog', { name: 'Пригласить в пространство' })

  fireEvent.change(screen.getByLabelText('Адрес почты'), { target: { value: 'new@example.com' } })
  // Диалог прячет фон от скринридера, поэтому кнопка с этим именем остаётся одна.
  fireEvent.click(screen.getByRole('button', { name: 'Пригласить' }))
  await waitFor(() => expect(writes()).toEqual(['POST /api/v1/workspaces/ws-team/invitations']))
})

it('редактор не видит ни приглашения, ни действий над строками', async () => {
  await renderMembers({
    members: [OWNER, MATE],
    permissions: ['member.read'],
    currentUserId: MATE.userId,
  })

  // Кабинет прячет кнопки по permissions с сервера, а не по роли, вычисленной на
  // фронте: матрица прав живёт в одном месте, и это не TypeScript.
  expect(screen.queryByRole('button', { name: 'Пригласить' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Действия: Пётр' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Приглашены, но ещё не вошли' })).toBeNull()
  // Снимок тарифа у редактора не спрашивается ВОВСЕ: ручка стоит за billing.view и
  // ответила бы 403 — то есть красной строкой в консоли на каждом открытии.
  expect(calls.filter((c) => c.includes('entitlements'))).toEqual([])
})

it('приглашение показывает срок и шлёт новое письмо той же ручкой', async () => {
  await renderMembers({
    members: [OWNER],
    invites: [{ email: 'wait@example.com', role: 'editor', expiresAt: '2026-09-15T10:00:00Z' }],
  })

  // Срок приезжает составом и раньше не показывался вовсе.
  expect(screen.getByText(/Ссылка действует до/)).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Отправить снова' }))
  // Отдельной ручки отзыва нет: повторное приглашение гасит прежнее (частичный
  // UNIQUE в 0017), поэтому «отправить снова» и есть отзыв старого письма.
  await waitFor(() => expect(writes()).toEqual(['POST /api/v1/workspaces/ws-team/invitations']))
})

it('счётчик мест рисуется только там, где у мест есть потолок', async () => {
  // Снимка в кэше нет — счётчика нет: «0 из 0» на месте незагруженного пугает
  // сильнее, чем пустое место.
  await renderMembers({ members: [OWNER, MATE] })
  expect(screen.queryByText(/мест$/)).toBeNull()
  cleanup()

  // Безлимит — тоже не число: «2 из ∞» рисовать нечем.
  await renderMembers({ members: [OWNER, MATE], seats: { used: 2, limit: null } })
  expect(screen.queryByText(/мест$/)).toBeNull()
  cleanup()

  await renderMembers({ members: [OWNER, MATE], seats: { used: 2, limit: 5 } })
  expect(screen.getByText('2 из 5 мест')).toBeTruthy()
})

it('исчерпанные места закрывают приглашение до набора адреса', async () => {
  await renderMembers({ members: [OWNER, MATE], seats: { used: 5, limit: 5 } })

  fireEvent.click(screen.getByRole('button', { name: 'Пригласить' }))
  await screen.findByRole('dialog', { name: 'Пригласить в пространство' })

  // Исчерпанный лимит не зависит от того, чью почту наберут, поэтому поля нет, а
  // вместо него — ответ «что делать».
  expect(screen.queryByLabelText('Адрес почты')).toBeNull()
  expect(screen.getByRole('link', { name: 'Посмотреть тарифы' })).toBeTruthy()
})
