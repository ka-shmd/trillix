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
      <PreviewPane title={title} badge={false} />
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
    // Кнопки «Назад» нет нигде и никогда (2026-08-22).
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

  // Линии шагов (решение владельца 2026-08-05): по одной на страницу. С 2026-08-22 они
  // НЕ кнопки: ход назад снят целиком — ни экранной «Назад», ни клика по линии, ни
  // записи в истории браузера. Индикатор остался счётчиком «где я и сколько всего».
  it('линий столько же, сколько страниц', () => {
    const { container } = renderPreview(threePages())
    expect(container.querySelectorAll('.rf-step-mark')).toHaveLength(3)
  })

  it('линия шага не кнопка ни на одном шаге', () => {
    const { container } = renderPreview(threePages())
    expect(container.querySelectorAll('button.rf-step-mark')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.getByLabelText('Шаг 3 из 3')).toBeTruthy()
    // Два шага позади — и ни один из них не стал кнопкой возврата.
    expect(container.querySelectorAll('button.rf-step-mark')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Вернуться к шагу/ })).toBeNull()
  })

  it('кнопки «Назад» нет и на последней странице', () => {
    renderPreview(threePages())
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.getByLabelText('Шаг 2 из 3')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull()
  })

  it('заголовок формы виден только на первой странице', () => {
    renderPreview(twoPages())
    expect(screen.getByRole('heading', { name: 'Анкета' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.queryByRole('heading', { name: 'Анкета' })).toBeNull()
  })
})

// Страница «Спасибо» (2026-08-21) — не шаг формы: индикатор её не считает, «Далее» на неё
// не ведёт, кнопка отправки стоит на последней странице ФОРМЫ. Расхождение здесь такое же
// молчаливое, как и с самими страницами: превью выглядело бы рабочим, а автор узнал бы о
// лишнем шаге от людей, которые в него ушли.
describe('превью и страница «Спасибо»', () => {
  const withThanks = (): Block[] => [
    ...twoPages(),
    { id: 'brkTY', groupId: '', type: 'page_break', settings: { thankYou: true } },
    { id: 'h', groupId: '', type: 'heading', text: textFromString('Готово, спасибо!') },
  ]

  it('в шагах её нет: две страницы формы, а не три', () => {
    renderPreview(withThanks())
    expect(screen.getByLabelText('Шаг 1 из 2')).toBeTruthy()
    expect(screen.queryByText('Готово, спасибо!')).toBeNull()
  })

  it('с последней страницы формы ведёт отправка, а не «Далее»', () => {
    renderPreview(withThanks())
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.getByLabelText('Шаг 2 из 2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Далее' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeTruthy()
  })

  it('отправка показывает страницу «Спасибо» — без шагов и без заголовка формы', () => {
    const { container } = renderPreview(withThanks())
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(screen.getByText('Готово, спасибо!')).toBeTruthy()
    expect(container.querySelector('.rf-steps')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Анкета' })).toBeNull()
    // Вопросов формы на этом экране нет — он показан ПОСЛЕ отправки.
    expect(screen.queryByLabelText(/Почта/)).toBeNull()
  })

  it('вопрос на этой странице гасит флаг: она снова обычный шаг', () => {
    renderPreview([
      ...twoPages(),
      { id: 'brkTY', groupId: '', type: 'page_break', settings: { thankYou: true } },
      ...question('c', 'Телефон'),
    ])
    expect(screen.getByLabelText('Шаг 1 из 3')).toBeTruthy()
  })
})
