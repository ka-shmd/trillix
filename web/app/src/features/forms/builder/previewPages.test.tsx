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

const threePages = (): Block[] => [
  ...twoPages(),
  { id: 'brk2', groupId: '', type: 'page_break' },
  ...question('c', 'Телефон'),
]

const twoPages = (): Block[] => [
  ...question('a', 'Имя'),
  { id: 'brk', groupId: '', type: 'page_break' },
  ...question('b', 'Почта'),
]

describe('превью листает страницы', () => {
  it('одностраничная форма шагов не показывает и сразу даёт кнопку отправки', () => {
    const { container } = renderPreview(question('a', 'Имя'))
    expect(container.querySelector('.rf-steps')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Далее' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeTruthy()
  })

  it('на первой странице второй вопрос не показан, а отправки нет', () => {
    renderPreview(twoPages())
    expect(screen.getByText('Имя')).toBeTruthy()
    expect(screen.queryByText('Почта')).toBeNull()
    expect(screen.getByLabelText('Шаг 1 из 2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Отправить' })).toBeNull()
    // Назад с первой страницы некуда — кнопки нет вовсе, а не disabled.
    expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull()
  })

  it('«Далее» показывает вторую страницу и кнопку отправки', () => {
    renderPreview(twoPages())
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.getByText('Почта')).toBeTruthy()
    expect(screen.queryByText('Имя')).toBeNull()
    expect(screen.getByLabelText('Шаг 2 из 2')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeTruthy()
  })

  // Место индикатора — часть WYSIWYG, а не вкус: он стоит ПОД кнопками шага (решение
  // владельца 2026-08-05), и разъедься это с рендерером, автор увидел бы не ту страницу,
  // которую увидит человек.
  it('линии шагов стоят ниже кнопок шага', () => {
    const { container } = renderPreview(twoPages())
    const nav = container.querySelector('.rf-nav')!
    const progress = container.querySelector('.rf-progress')!
    // DOCUMENT_POSITION_FOLLOWING = индикатор идёт ПОСЛЕ навигации в порядке документа.
    expect(nav.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // Видимой подписи «Шаг N из M» нет, но счёт обязан оставаться доступным: линии для
  // скринридера — пустые прямоугольники.
  it('счёт шагов остаётся скринридеру именем списка и живой областью', () => {
    const { container } = renderPreview(twoPages())
    expect(container.querySelector('.rf-steps')!.getAttribute('aria-label')).toBe('Шаг 1 из 2')
    const live = container.querySelector('[role="status"]')!
    expect(live.textContent).toBe('Шаг 1 из 2')
    // Текст есть в DOM, но невидим — иначе подпись бы вернулась.
    expect(live.className).toContain('rf-sr-only')
  })

  // Линии шагов (решение владельца 2026-08-05): по одной на страницу, кликом — только
  // НАЗАД. Кликабельность вперёд сделала бы из индикатора оглавление со скачком, а оно
  // обесценивает пошаговую валидацию — то самое, от чего владелец отказался в первой
  // развилке фазы.
  it('линий столько же, сколько страниц', () => {
    const { container } = renderPreview(threePages())
    expect(container.querySelectorAll('.rf-step-mark')).toHaveLength(3)
  })

  it('вперёд по линиям не ходят: непройденный шаг — не кнопка вовсе', () => {
    const { container } = renderPreview(threePages())
    // На первом шаге кнопок-линий нет ни одной: назад некуда, вперёд нельзя.
    expect(container.querySelectorAll('button.rf-step-mark')).toHaveLength(0)
  })

  it('клик по пройденной линии возвращает на её шаг', () => {
    const { container } = renderPreview(threePages())
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.getByLabelText('Шаг 3 из 3')).toBeTruthy()

    // Пройденных шагов теперь два, текущий кнопкой не бывает.
    expect(container.querySelectorAll('button.rf-step-mark')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Вернуться к шагу 1 из 3' }))
    expect(screen.getByLabelText('Шаг 1 из 3')).toBeTruthy()
    expect(screen.getByLabelText(/Имя/)).toBeTruthy()
  })

  it('заголовок формы виден только на первой странице', () => {
    renderPreview(twoPages())
    expect(screen.getByRole('heading', { name: 'Анкета' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.queryByRole('heading', { name: 'Анкета' })).toBeNull()
  })
})
