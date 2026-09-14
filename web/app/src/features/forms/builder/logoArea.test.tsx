// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SCHEMA_VERSION, type FormSchema } from '@entities/formSchema'

import { LogoArea } from './CoverEditor'
import { importImage } from './mediaUpload'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'

vi.mock('./mediaUpload', () => ({ uploadImage: vi.fn(), importImage: vi.fn() }))

// Логотип на полотне без кнопок: нажатие на знак открывает окно логотипа — загрузка,
// ссылка и удаление, без вкладки цвета. Замена картинки не сбрасывает размеры.

afterEach(() => {
  cleanup()
  vi.mocked(importImage).mockReset()
})

function setup() {
  const store = createBuilderStore()
  store.getState().hydrate({
    schemaVersion: SCHEMA_VERSION,
    blocks: [],
    logo: { imageKey: 'ws/logo.png', width: 140 },
  } as FormSchema)
  render(
    <BuilderStoreContext.Provider value={store}>
      <LogoArea formId="f1" over={false} />
    </BuilderStoreContext.Provider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Изменить логотип' }))
  return store
}

describe('логотип на полотне', () => {
  it('нажатие на знак открывает окно без вкладки цвета', () => {
    setup()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Загрузить', 'Ссылка'])
  })

  it('картинка по ссылке заменяет знак, размеры остаются', async () => {
    vi.mocked(importImage).mockResolvedValue('ws/new-logo.png')
    const store = setup()

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Ссылка' }))
    fireEvent.change(screen.getByLabelText('Ссылка на картинку'), {
      target: { value: 'https://images.example/logo.png' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Применить' }))
    })

    expect(importImage).toHaveBeenCalledWith('f1', 'https://images.example/logo.png', 'logo')
    expect(store.getState().logo).toEqual({ imageKey: 'ws/new-logo.png', width: 140 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('«Удалить» снимает логотип', () => {
    const store = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    expect(store.getState().logo).toBeUndefined()
  })
})
