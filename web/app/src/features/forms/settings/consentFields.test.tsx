// @vitest-environment happy-dom
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ConsentOperatorItem, ConsentState } from '../../../entities/consent'
import { ConsentFields } from './ConsentFields'
import { consentDraftFrom, validateConsent, type ConsentDraft } from './consentDraft'
import { TooltipProvider } from '@/components/ui/tooltip'

// Раздел «Персональные данные» (design/privacy-consent.md §3.2, §3.6): один выбор
// источника на оба документа и подсказка реквизитов из списка пространства.

const api = vi.hoisted(() => ({
  operators: [] as ConsentOperatorItem[],
  deleted: [] as string[],
  listed: 0,
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    listConsentOperators: () => {
      api.listed++
      return Promise.resolve(api.operators)
    },
    deleteConsentOperator: (id: string) => {
      api.deleted.push(id)
      api.operators = api.operators.filter((it) => it.id !== id)
      return Promise.resolve()
    },
  }
})

const ROMASHKA: ConsentOperatorItem = {
  id: 'op-1',
  name: 'ООО «Ромашка»',
  inn: '7700000000',
  address: 'Казань',
  email: 'pd@romashka.ru',
}
const IVANOV: ConsentOperatorItem = {
  id: 'op-2',
  name: 'ИП Иванов',
  inn: '',
  address: 'Тула',
  email: 'i@example.com',
}

const EMPTY: ConsentState = {
  enabled: true,
  operator: { name: '', inn: '', address: '', email: '' },
  purpose: '',
  retention: '',
  documents: 'template',
  consentText: '',
  policyText: '',
  revisionId: null,
  updatedAt: null,
}

// Черновик, каким его видит страница настроек после последней правки.
const seen: { draft: ConsentDraft | null } = { draft: null }

function Harness({ initial }: { initial: ConsentDraft }) {
  const [draft, setDraft] = useState(initial)
  useEffect(() => {
    seen.draft = draft
  }, [draft])
  return (
    <ConsentFields
      formId="form-1"
      workspaceId="ws-1"
      draft={draft}
      set={(key, value) => setDraft((d) => ({ ...d, [key]: value }))}
      invalid={validateConsent(draft)}
    />
  )
}

function renderFields(initial: ConsentDraft = consentDraftFrom(EMPTY)) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Harness initial={initial} />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  api.operators = []
  api.deleted = []
  api.listed = 0
})

// Ответ списка доехал до экрана: запрос ушёл, и микрозадачи после него разобраны.
async function listLoaded() {
  await waitFor(() => expect(api.listed).toBeGreaterThan(0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('раздел согласия', () => {
  it('«Свои» прячет реквизиты и показывает два текста, выбор один на оба документа', () => {
    renderFields()
    expect(screen.getByLabelText('Оператор')).toBeTruthy()
    // Цель и срок видны сразу, не за «Изменить» (решение владельца 2026-09-17).
    expect(screen.getByLabelText('Цель обработки')).toBeTruthy()
    expect(screen.getByLabelText('Срок обработки')).toBeTruthy()

    // Радиксовые вкладки переключаются нажатием мыши, а не click.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Свои' }))

    expect(seen.draft?.documents).toBe('custom')
    expect(screen.queryByLabelText('Оператор')).toBeNull()
    expect(screen.getByLabelText('Согласие на обработку персональных данных')).toBeTruthy()
    expect(screen.getByLabelText('Политика обработки персональных данных')).toBeTruthy()
  })

  it('подсказка предлагает сохранённые реквизиты и подставляет весь набор', async () => {
    api.operators = [ROMASHKA, IVANOV]
    renderFields()
    fireEvent.focus(screen.getByLabelText('Оператор'))

    const option = await screen.findByRole('button', { name: /ООО «Ромашка»/ })
    expect(screen.getByRole('button', { name: /ИП Иванов/ })).toBeTruthy()
    // Имя группы — то, по которому соседние тесты проверяют, что подсказки НЕТ.
    expect(screen.getByRole('group', { name: 'Реквизиты из других форм' })).toBeTruthy()
    fireEvent.click(option)

    expect(seen.draft).toMatchObject({
      name: 'ООО «Ромашка»',
      inn: '7700000000',
      address: 'Казань',
      email: 'pd@romashka.ru',
    })
  })

  it('набор сужается по наименованию, а совпавший с введённым не предлагается', async () => {
    api.operators = [ROMASHKA, IVANOV]
    renderFields({
      ...consentDraftFrom(EMPTY),
      name: 'ИП Иванов',
      address: 'Тула',
      email: 'i@example.com',
    })
    const input = screen.getByLabelText('Оператор')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'ооо' } })
    expect(await screen.findByRole('button', { name: /ООО «Ромашка»/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /ИП Иванов/ })).toBeNull()

    // Введённый набор совпадает с Ивановым целиком, а Ромашка не подходит по имени.
    fireEvent.change(input, { target: { value: 'ИП Иванов' } })
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Реквизиты из других форм' })).toBeNull(),
    )
  })

  it('«Убрать из списка» удаляет набор, форму не трогая', async () => {
    api.operators = [ROMASHKA, IVANOV]
    renderFields()
    fireEvent.focus(screen.getByLabelText('Оператор'))
    const [removeFirst] = await screen.findAllByRole('button', { name: 'Убрать из списка' })
    if (!removeFirst) throw new Error('у подсказки нет «Убрать из списка»')
    fireEvent.click(removeFirst)

    await waitFor(() => expect(api.deleted).toEqual(['op-1']))
    await waitFor(() => expect(screen.queryByRole('button', { name: /ООО «Ромашка»/ })).toBeNull())
    expect(seen.draft?.name).toBe('')
  })

  it('без сохранённых реквизитов подсказки нет', async () => {
    renderFields()
    fireEvent.focus(screen.getByLabelText('Оператор'))
    await listLoaded()
    expect(screen.queryByRole('group', { name: 'Реквизиты из других форм' })).toBeNull()
  })
})
