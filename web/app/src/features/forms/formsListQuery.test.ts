import { afterEach, describe, expect, it, vi } from 'vitest'

import { listForms } from './api'
import { apiRequest } from '../../shared/api/client'

vi.mock('../../shared/api/client', () => ({ apiRequest: vi.fn(() => Promise.resolve(null)) }))

afterEach(() => vi.mocked(apiRequest).mockClear())

function askedPath(): string {
  return vi.mocked(apiRequest).mock.calls.at(-1)?.[0] as string
}

describe('запрос списка форм', () => {
  // «Все» — значение ЭКРАНА, а не сервера: у API «все статусы» выражается
  // отсутствием параметра, и `status=all` он не знает вовсе — ответил бы 422 и
  // положил список целиком.
  it('фильтр «Все» в запрос не уходит', async () => {
    await listForms(undefined, { status: 'all' })
    expect(askedPath()).not.toContain('status')
  })

  it('выбранный статус уходит параметром', async () => {
    await listForms(undefined, { status: 'draft' })
    expect(askedPath()).toContain('status=draft')
  })

  // Умолчание сортировки в адрес не пишется — тем же правилом, что и «все».
  it('умолчание сортировки в запрос не уходит, а другой порядок — уходит', async () => {
    await listForms(undefined, { sort: 'updated' })
    expect(askedPath()).not.toContain('sort')

    await listForms(undefined, { sort: 'responses' })
    expect(askedPath()).toContain('sort=responses')
  })
})
