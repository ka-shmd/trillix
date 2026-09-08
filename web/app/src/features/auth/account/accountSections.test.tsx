// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { User } from '../../../entities/user'
import { authKeys, oauthKeys } from '../keys'
import { DeleteAccountSection } from './DeleteAccountSection'
import { ProfileSection } from './ProfileSection'
import { SignInSection } from './SignInSection'
import { DevicesSection, TwoFactorSection } from './TwoFactorSection'

// Сторожа на три дефекта прежней страницы и на одно решение владельца. Все
// четыре ломаются молча: экран продолжает рисоваться, а поведение меняется.

const USER: User = {
  id: 'u1',
  email: 'ivan@example.com',
  emailVerified: true,
  firstName: 'Иван',
  lastName: 'Петров',
  hasPassword: true,
  avatarKey: '',
  twoFactorEnabled: false,
}

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

function wrap(node: ReactNode, seed?: (qc: QueryClient) => void) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  qc.setQueryData(authKeys.me(), USER)
  seed?.(qc)
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

it('пароль — строка списка способов входа, а не отдельный раздел', () => {
  wrap(<SignInSection user={USER} onLinkOutcome={() => {}} onLinkClear={() => {}} />, (qc) => {
    qc.setQueryData(authKeys.identities(), [])
    qc.setQueryData(oauthKeys.providers(), [])
  })

  // Строка есть, и у неё ЕСТЬ действие: пока пароль жил отдельным разделом, эта
  // строка только повторяла его и была единственной в списке без кнопки.
  expect(screen.getByText('Пароль')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Сменить' })).toBeTruthy()
  // Заголовок раздела на странице ровно один — «Способы входа».
  expect(screen.queryByRole('heading', { name: 'Пароль' })).toBeNull()
})

it('тумблер второго фактора не включает его сам, а открывает подтверждение', async () => {
  wrap(<TwoFactorSection user={USER} />)

  // Ссылку держим до открытия диалога: тот прячет фон от скринридера, и по роли
  // тумблер после открытия уже не находится.
  const toggle = screen.getByRole('switch')
  fireEvent.click(toggle)

  await screen.findByRole('heading', { name: 'Включить второй фактор?' })
  // Ни одного запроса до подтверждения: пароль ещё не введён, и тумблер обязан
  // показывать серверное состояние, а не намерение.
  expect(calls).toEqual([])
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})

it('«Забыть все» спрашивает подтверждение до запроса', async () => {
  wrap(<DevicesSection />, (qc) => {
    qc.setQueryData(authKeys.devices(), [
      { id: 'd1', label: 'Chrome на Windows', lastSeenAt: '', createdAt: '', current: true },
    ])
  })

  fireEvent.click(screen.getByRole('button', { name: 'Забыть все' }))
  // Кнопка рвёт все сеансы, кроме текущего, — последствие шире, чем обещает её
  // подпись, поэтому оно названо ДО нажатия. Считаем только записи: чтение
  // списка устройств Query обновляет само.
  await screen.findByText(/Все сеансы, кроме текущего, будут завершены/)
  expect(writes()).toEqual([])

  // После открытия диалога фон спрятан от скринридера, поэтому кнопка с этим
  // именем в дереве доступности остаётся одна — та, что в диалоге.
  fireEvent.click(screen.getByRole('button', { name: 'Забыть все' }))
  await waitFor(() => expect(writes()).toEqual(['DELETE /api/v1/account/devices']))
})

it('действия с фото живут в самом фото, отдельного значка рядом нет', () => {
  wrap(<ProfileSection user={{ ...USER, avatarKey: 'avatars/u1.jpg' }} />)

  // Нажимаемое место раздела ОДНО, и это сам кружок: проверяем не по имени
  // кнопки, а по тому, что внутри неё лежит аватар (у Radix это fallback с
  // инициалами). Значок «⋯» рядом убран решением владельца — кнопка с этой
  // подписью не должна вернуться.
  const trigger = screen.getByRole('button', { name: 'Действия с фото' })
  expect(within(trigger).getByText('ИП')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Действия с фото' })).toBe(trigger)
  expect(screen.queryByLabelText('Действия с фото')).toBe(trigger)

  // Ограничения формата и веса — граница реализации, и до отказа она человеку
  // не нужна (решение по разделу, 2026-09-08).
  expect(screen.queryByText(/5 МБ/)).toBeNull()
})

it('без фото кружок ведёт сразу к выбору файла, а не в меню из одного пункта', () => {
  wrap(<ProfileSection user={USER} />)

  const circle = screen.getByRole('button', { name: 'Загрузить фото' })
  expect(within(circle).getByText('ИП')).toBeTruthy()
  // Триггер меню Radix помечает себя ролью и состоянием; у этой кнопки их нет.
  expect(circle.getAttribute('aria-haspopup')).toBeNull()
})

it('имя правится диалогом, как всё остальное на странице, а не формой в разделе', async () => {
  wrap(<ProfileSection user={USER} />)

  // В потоке страницы полей нет: раздел был единственной сырой формой среди
  // строк с действием, и это ломало вид страницы при любой расстановке частей
  // (решение владельца 2026-09-08).
  expect(screen.queryByLabelText('Имя')).toBeNull()
  expect(screen.getByText('Иван Петров')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Изменить имя' }))
  await screen.findByRole('heading', { name: 'Имя и фамилия' })
  expect(screen.getByLabelText('Имя')).toBeTruthy()
  expect(screen.getByLabelText('Фамилия')).toBeTruthy()
})

it('пустое имя названо пустым, а не подменено адресом почты', () => {
  wrap(<ProfileSection user={{ ...USER, firstName: '', lastName: '' }} />)

  // displayName возвращает адрес, когда имени нет, — и строка молча стала бы
  // дублем соседнего раздела «Адрес аккаунта».
  expect(screen.getByText('Имя не указано')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Указать имя' })).toBeTruthy()
})

it('адрес почты показан справочной строкой, менять его не предлагают', () => {
  wrap(<ProfileSection user={USER} />)

  // Почта и есть аккаунт (решение владельца 2026-09-08): строка есть, действия
  // при ней нет — ни здесь, ни где-либо ещё в кабинете.
  expect(screen.getByText(USER.email)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /адрес/i })).toBeNull()
  expect(screen.queryByRole('button', { name: /почт/i })).toBeNull()
})

it('отказ привязки провайдера объясняется диалогом, а не строкой над списком', async () => {
  const cleared = vi.fn()
  wrap(
    <SignInSection user={USER} link="conflict" onLinkOutcome={() => {}} onLinkClear={cleared} />,
    (qc) => {
      qc.setQueryData(authKeys.identities(), [])
      qc.setQueryData(oauthKeys.providers(), ['yandex'])
    },
  )

  // Человек возвращается из чужого окна и смотрит на список способов входа:
  // абзац над списком прочитывали не раньше, чем замечали отсутствие новой
  // строки (решение владельца 2026-09-08).
  await screen.findByRole('heading', { name: 'Этот аккаунт уже привязан' })

  // Закрытие снимает параметр адреса — иначе диалог открылся бы снова на
  // следующем заходе на страницу.
  fireEvent.click(screen.getByRole('button', { name: 'Понятно' }))
  expect(cleared).toHaveBeenCalled()
})

it('успех привязки диалогом не празднуют', () => {
  wrap(
    <SignInSection user={USER} link="ok" onLinkOutcome={() => {}} onLinkClear={() => {}} />,
    (qc) => {
      qc.setQueryData(authKeys.identities(), [])
      qc.setQueryData(oauthKeys.providers(), [])
    },
  )

  expect(screen.queryByRole('alertdialog')).toBeNull()
})

it('строки разделов не обведены рамкой', () => {
  wrap(<SignInSection user={USER} onLinkOutcome={() => {}} onLinkClear={() => {}} />, (qc) => {
    qc.setQueryData(authKeys.identities(), [])
    qc.setQueryData(oauthKeys.providers(), [])
  })

  // DESIGN-SYSTEM §7, «Плоскость вместо рамки»: список однородных строк не
  // получает ни рамки, ни подложки — граница вокруг каждой строки рисует
  // различие там, где различать нечего. Класс, а не вид: правило невидимо
  // любой проверке поведения, а коробка возвращается копипастой с соседнего
  // экрана — ровно так она сюда и попала.
  const list = screen.getByRole('list')
  expect(list.className).toContain('border-t')
  expect(list.className).not.toContain('rounded')
  expect(list.className.split(/\s+/)).not.toContain('border')
})

it('удаление спрашивает пароль и код на РАЗНЫХ страницах диалога', async () => {
  wrap(<DeleteAccountSection user={{ ...USER, twoFactorEnabled: true }} onDeleted={() => {}} />)

  fireEvent.click(screen.getByRole('button', { name: 'Удалить аккаунт' }))
  await screen.findByRole('heading', { name: 'Удалить аккаунт навсегда?' })

  // Первая страница — только пароль: доказательства разной природы не стоят
  // рядом набором полей (решение владельца 2026-09-08).
  expect(screen.getByLabelText('Текущий пароль')).toBeTruthy()
  expect(screen.queryByLabelText('Код из письма')).toBeNull()

  fireEvent.change(screen.getByLabelText('Текущий пароль'), { target: { value: 'pass' } })
  fireEvent.click(screen.getByRole('button', { name: 'Далее' }))

  // «Далее» не пустой переход: он отправляет код, и удаления ещё не случилось.
  await waitFor(() => expect(writes()).toEqual(['POST /api/v1/account/2fa/send-code']))
  await screen.findByRole('heading', { name: 'Подтвердите, что это вы' })
  expect(screen.queryByLabelText('Текущий пароль')).toBeNull()

  fireEvent.change(screen.getByLabelText('Код из письма'), { target: { value: '123456' } })
  fireEvent.click(screen.getByRole('button', { name: 'Удалить аккаунт' }))
  await waitFor(() =>
    expect(writes()).toEqual(['POST /api/v1/account/2fa/send-code', 'POST /api/v1/account/delete']),
  )
})

it('без второго фактора страница одна — шага с кодом не существует', async () => {
  wrap(<DeleteAccountSection user={USER} onDeleted={() => {}} />)

  fireEvent.click(screen.getByRole('button', { name: 'Удалить аккаунт' }))
  await screen.findByRole('heading', { name: 'Удалить аккаунт навсегда?' })

  // Ни счётчика страниц, ни «Далее»: мастера, которого нет, обещать нельзя.
  expect(screen.queryByText(/Шаг 1 из 2/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Далее' })).toBeNull()

  fireEvent.change(screen.getByLabelText('Текущий пароль'), { target: { value: 'pass' } })
  fireEvent.click(screen.getByRole('button', { name: 'Удалить аккаунт' }))
  await waitFor(() => expect(writes()).toEqual(['POST /api/v1/account/delete']))
})
