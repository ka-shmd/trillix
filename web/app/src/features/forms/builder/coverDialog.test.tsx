// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { SCHEMA_VERSION, type FormSchema } from '@entities/formSchema'

import { ApiError } from '../../../shared/api/errors'
import { CoverDialog } from './CoverDialog'
import { importImage, uploadImage } from './mediaUpload'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'

vi.mock('./mediaUpload', () => ({ uploadImage: vi.fn(), importImage: vi.fn() }))

// Окно обложки: файл, ссылка и цвет меняют ОДНУ обложку стора, «Удалить» в углу её
// снимает. Сеть подменена — проверяется граница окна со стором, а не загрузка.

afterEach(() => {
  cleanup()
  vi.mocked(uploadImage).mockReset()
  vi.mocked(importImage).mockReset()
})

function setup(schema: Partial<FormSchema> = {}) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks: [], ...schema } as FormSchema)
  render(
    <BuilderStoreContext.Provider value={store}>
      <CoverDialog formId="f1">
        <button type="button">Изменить</button>
      </CoverDialog>
    </BuilderStoreContext.Provider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Изменить' }))
  return store
}

// Radix Tabs переключается на mousedown, а не на click.
const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }))

describe('окно обложки', () => {
  it('картинка по ссылке становится обложкой, окно закрывается', async () => {
    vi.mocked(importImage).mockResolvedValue('ws/cover.png')
    const store = setup({ cover: { color: '#ff8800', height: 30 } })

    openTab('Ссылка')
    fireEvent.change(screen.getByLabelText('Ссылка на картинку'), {
      target: { value: '  https://images.example/pic.png ' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Применить' }))
    })

    expect(importImage).toHaveBeenCalledWith('f1', 'https://images.example/pic.png', 'cover')
    // Высота полосы переживает смену наполнения.
    expect(store.getState().cover).toEqual({ imageKey: 'ws/cover.png', height: 30 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('отказ сервера по ссылке показывается словами, окно остаётся', async () => {
    // Настоящий отказ приходит ApiError с причиной сервера (apiRequest): humanError
    // показывает только такой текст.
    vi.mocked(importImage).mockRejectedValue(
      new ApiError(422, 'validation_failed', 'ссылка ведёт во внутреннюю сеть — оттуда картинки не загружаются'),
    )
    const store = setup()

    openTab('Ссылка')
    fireEvent.change(screen.getByLabelText('Ссылка на картинку'), {
      target: { value: 'https://10.0.0.5/pic.png' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Применить' }))
    })

    expect((await screen.findByRole('alert')).textContent).toContain('внутреннюю сеть')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(store.getState().cover).toBeUndefined()
  })

  it('перетащенный файл уходит загрузкой обложки', async () => {
    vi.mocked(uploadImage).mockResolvedValue('ws/dropped.png')
    const store = setup()
    const file = new File(['png'], 'pic.png', { type: 'image/png' })

    const zone = screen.getByRole('button', { name: /перетащите его сюда/ })
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    })

    expect(vi.mocked(uploadImage).mock.calls[0]![0]).toBe('f1')
    expect(vi.mocked(uploadImage).mock.calls[0]![1]).toBe(file)
    expect(vi.mocked(uploadImage).mock.calls[0]![3]).toBe('cover')
    expect(store.getState().cover).toEqual({ imageKey: 'ws/dropped.png' })
  })

  it('«Удалить» в углу снимает обложку; у пустой обложки его нет', () => {
    const store = setup({ cover: { color: '#ff8800' } })
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }))
    expect(store.getState().cover).toBeUndefined()
    expect(screen.queryByRole('dialog')).toBeNull()

    cleanup()
    setup()
    expect(screen.queryByRole('button', { name: 'Удалить' })).toBeNull()
  })
})
