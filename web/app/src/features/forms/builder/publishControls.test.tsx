// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { SCHEMA_VERSION, textFromString, type FormSchema } from '@entities/formSchema'
import { type Form } from '../../../entities/form'
import { PublishControls } from './PublishControls'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { FormFactsProvider } from './formFacts'
import { TooltipProvider } from '@/components/ui/tooltip'

// Гейт ТАРИФА к этой проверке отношения не имеет: он живёт в диалоге по нажатию и
// кнопку не гасит. Подменяем его, чтобы не тащить сюда пространство и подписку.
vi.mock('../../plan/useFeature', () => ({ useFeatureAllowed: () => true }))

// КНОПКА «ОПУБЛИКОВАТЬ» ГАСНЕТ, А ПРИЧИНУ ГОВОРИТ ТУЛТИП (решение владельца
// 2026-09-04). До этого причина стояла подписью в попапе блока и рассказывала лишь
// половину: про обязательный вопрос о почте попап не знает ничего.

afterEach(cleanup)

const form: Form = {
  id: 'f1',
  name: null,
  title: 'Запись',
  slug: 'zapis',
  status: 'draft',
  createdAt: '2026-09-04T10:00:00Z',
  updatedAt: '2026-09-04T10:00:00Z',
  publishedVersion: null,
  publishedVersionId: null,
  hasUnpublishedChanges: false,
  submissionCount: 0,
  lastSubmissionAt: null,
  visitCount: 0,
  visitSubmittedCount: 0,
}

const slotForm: FormSchema['blocks'] = [
  { id: 't1', groupId: 'g1', type: 'title', text: textFromString('Когда удобно') },
  { id: 's1', groupId: 'g1', type: 'slot' },
]

const withEmail: FormSchema['blocks'] = [
  ...slotForm,
  { id: 't2', groupId: 'g2', type: 'title', text: textFromString('Почта') },
  { id: 'e1', groupId: 'g2', type: 'email', required: true },
]

function setup(blocks: FormSchema['blocks'], scheduleId: string | null) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks })
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        {/* Как в кабинете: провайдер тултипов даёт SidebarProvider выше по дереву. */}
        <TooltipProvider>
          <BuilderStoreContext.Provider value={store}>
            <FormFactsProvider
              value={{ id: 'f1', workspaceId: 'ws-1', workspaceSlug: 'w', scheduleId }}
            >
              <PublishControls
                form={form}
                canPublish
                ensureForm={() => Promise.resolve({ id: 'f1', slug: 'zapis' })}
              />
            </FormFactsProvider>
          </BuilderStoreContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    // Дочерний маршрут обязателен: корень без детей роутер не отрисовывает, и
    // компонент до DOM не доезжает вовсе.
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/settings/plan',
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router as never} />)
}

// Кнопка ищется асинхронно: роутер монтирует дерево не в первом тике, и синхронный
// поиск застаёт пустой DOM.
async function publishButton(): Promise<HTMLButtonElement> {
  return (await screen.findByRole('button', { name: 'Опубликовать' })) as HTMLButtonElement
}

describe('кнопка публикации формы записи', () => {
  it('без расписания и без почты — погашена', async () => {
    setup(slotForm, null)
    expect((await publishButton()).disabled).toBe(true)
  })

  it('расписание выбрано, обязательной почты нет — всё ещё погашена', async () => {
    setup(slotForm, 'sch-1')
    expect((await publishButton()).disabled).toBe(true)
  })

  it('всё на месте — кнопка живая', async () => {
    setup(withEmail, 'sch-1')
    expect((await publishButton()).disabled).toBe(false)
  })

  it('обычная форма без записи гейтом не задета', async () => {
    setup([{ id: 'q1', groupId: 'g1', type: 'short_text' }], null)
    expect((await publishButton()).disabled).toBe(false)
  })

  // ⚠ ОТКРЫТИЕ ТУЛТИПА ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ: Radix открывает его по настоящим
  // pointer-событиям, а синтетические в happy-dom до него не доходят — проверялась бы
  // библиотека, а не наш код. Наше здесь — КАКАЯ причина и КОГДА кнопка гаснет; это
  // сторожат случаи выше и publishGate.test.ts. Сам тултип смотрится глазами.
})

// Мутация публикации в этих проверках не вызывается ни разу: кнопка либо погашена,
// либо её просто не жмут. Сеть на всякий случай заглушена — тест не должен зависеть
// от того, есть ли она.
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
)
