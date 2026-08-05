// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { type Block, SCHEMA_VERSION, textFromString } from '@entities/formSchema'

import { PreviewPane } from './PreviewPane'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'

// Превью обязано листать форму так же, как её листает респондент (фаза 19). Сторож
// нужен потому, что расхождение здесь молчаливое: превью, рисующее все страницы подряд,
// выглядит рабочим — просто автор узнаёт о шагах уже от людей, которые их не прошли.

afterEach(cleanup)

const question = (id: string, caption: string): Block[] => [
  { id: `t_${id}`, groupId: '', type: 'title', text: textFromString(caption) },
  { id, groupId: '', type: 'short_text' },
]

function renderPreview(blocks: Block[], title = 'Анкета') {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks })
  return render(
    <BuilderStoreContext.Provider value={store}>
      <PreviewPane title={title} />
    </BuilderStoreContext.Provider>,
  )
}

const twoPages = (): Block[] => [
  ...question('a', 'Имя'),
  { id: 'brk', groupId: '', type: 'page_break' },
  ...question('b', 'Почта'),
]

describe('превью листает страницы', () => {
  it('одностраничная форма шагов не показывает и сразу даёт кнопку отправки', () => {
    renderPreview(question('a', 'Имя'))
    expect(screen.queryByText(/Шаг/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Далее' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeTruthy()
  })

  it('на первой странице второй вопрос не показан, а отправки нет', () => {
    renderPreview(twoPages())
    expect(screen.getByText('Имя')).toBeTruthy()
    expect(screen.queryByText('Почта')).toBeNull()
    expect(screen.getByText('Шаг 1 из 2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Отправить' })).toBeNull()
    // Назад с первой страницы некуда — кнопки нет вовсе, а не disabled.
    expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull()
  })

  it('«Далее» показывает вторую страницу и кнопку отправки', () => {
    renderPreview(twoPages())
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.getByText('Почта')).toBeTruthy()
    expect(screen.queryByText('Имя')).toBeNull()
    expect(screen.getByText('Шаг 2 из 2')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeTruthy()
  })

  it('заголовок формы виден только на первой странице', () => {
    renderPreview(twoPages())
    expect(screen.getByRole('heading', { name: 'Анкета' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.queryByRole('heading', { name: 'Анкета' })).toBeNull()
  })
})
