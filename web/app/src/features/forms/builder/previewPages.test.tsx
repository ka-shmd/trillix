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

function renderPreview(
  blocks: Block[],
  { allowBack = false, title = 'Анкета', consent = false } = {},
) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks })
  return render(
    <BuilderStoreContext.Provider value={store}>
      {/* progress={true} явно: шкала прогресса — тумблер формы, по умолчанию
          выключенный (миграция 0040), а тесты ниже проверяют именно её разметку и
          место. Без этого пропа проверять было бы нечего.

          allowBack приходит вторым тумблером (0055) и по умолчанию ВЫКЛЮЧЕН — как
          колонка: без него превью обязано листаться только вперёд. */}
      <PreviewPane title={title} badge={false} progress allowBack={allowBack} consent={consent} />
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
    // Ход назад выключен (дефолт 0055) — кнопки «Назад» нет ни на одной странице.
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

  // Линии шагов (решение владельца 2026-08-05): по одной на страницу. При выключенном
  // `allowBack` (дефолт колонки 0055) они НЕ кнопки — индикатор остаётся счётчиком «где
  // я и сколько всего», и ход назад не открывается ничем.
  it('линий столько же, сколько страниц', () => {
    const { container } = renderPreview(threePages())
    expect(container.querySelectorAll('.rf-step-mark')).toHaveLength(3)
  })

  it('линия шага не кнопка ни на одном шаге, пока ход назад выключен', () => {
    const { container } = renderPreview(threePages())
    expect(container.querySelectorAll('button.rf-step-mark')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.getByLabelText('Шаг 3 из 3')).toBeTruthy()
    // Два шага позади — и ни один из них не стал кнопкой возврата.
    expect(container.querySelectorAll('button.rf-step-mark')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Вернуться к шагу/ })).toBeNull()
  })

  it('кнопки «Назад» нет и на последней странице, пока ход назад выключен', () => {
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

// Ход назад (`allowBack`, 0055) автор обязан увидеть в превью ровно таким, каким его
// получит респондент: те же два пути и то же правило «вперёд — только через «Далее».
// Расхождение здесь молчаливое — превью листалось бы вперёд и выглядело рабочим, а о
// кнопке «Назад» у себя на форме автор узнал бы от людей.
describe('превью с включённым ходом назад', () => {
  it('«Назад» появляется со второй страницы и возвращает на первую', () => {
    renderPreview(twoPages(), { allowBack: true })
    // На первой странице идти назад некуда — кнопки нет.
    expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.getByLabelText('Шаг 2 из 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }))
    expect(screen.getByLabelText('Шаг 1 из 2')).toBeTruthy()
    expect(screen.getByText('Имя')).toBeTruthy()
  })

  it('кнопками становятся ТОЛЬКО пройденные линии, и клик по ним ведёт назад', () => {
    const { container } = renderPreview(threePages(), { allowBack: true })
    // На первом шаге позади ничего нет: кнопок ноль при трёх линиях.
    expect(container.querySelectorAll('.rf-step-mark')).toHaveLength(3)
    expect(container.querySelectorAll('button.rf-step-mark')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    expect(screen.getByLabelText('Шаг 3 из 3')).toBeTruthy()
    // Два шага позади — две кнопки; текущий и те, что впереди, кнопками не стали.
    expect(container.querySelectorAll('button.rf-step-mark')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Вернуться к шагу 1 из 3' }))
    expect(screen.getByLabelText('Шаг 1 из 3')).toBeTruthy()
  })

  // ⚠ Сторож против возврата дефекта TD-57/TD-58: кнопкой становится шаг ПОЗАДИ
  // текущего, а не «любой достигнутый». Иначе с первой страницы можно уйти на вторую
  // кликом по линии — мимо «Далее», то есть мимо проверки текущей страницы.
  it('вернувшись назад, вперёд по линиям уйти нельзя', () => {
    const { container } = renderPreview(threePages(), { allowBack: true })
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    fireEvent.click(screen.getByRole('button', { name: 'Вернуться к шагу 1 из 3' }))
    expect(screen.getByLabelText('Шаг 1 из 3')).toBeTruthy()
    expect(container.querySelectorAll('button.rf-step-mark')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Вернуться к шагу/ })).toBeNull()
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

  // Форма БЕЗ такой страницы: отправка обязана что-то показать. Контрол, живой на вид и
  // пустой на нажатие, читается как поломка продукта, а не как «этой страницы у вас
  // нет», и ловится он только нажатием — по разметке кнопка неотличима от рабочей.
  it('без страницы «Спасибо» отправка объясняет, что увидит респондент, а не молчит', () => {
    renderPreview(twoPages())
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(screen.getByText(/Экран после отправки в этой форме не собран/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Вернуться к форме/ })).toBeTruthy()
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

// Согласие на обработку персональных данных (0069): превью показывает галочку там же, где
// респондент, и так же не «отправляет» форму без неё.
describe('превью и согласие', () => {
  it('согласие выключено — галочки нет, отправка проходит', () => {
    renderPreview(question('a', 'Имя'))
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(screen.getByRole('button', { name: /Вернуться к форме/ })).toBeTruthy()
  })

  it('галочка только на последней странице, под кнопкой отправки', () => {
    const { container } = renderPreview(twoPages(), { consent: true })
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    const box = container.querySelector('.rf-consent-box')
    expect(box).toBeTruthy()
    // Под кнопкой: блок согласия идёт в разметке после ряда с кнопкой.
    const nav = container.querySelector('.rf-nav')!
    expect(nav.compareDocumentPosition(box!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'Политика обработки персональных данных' }),
    ).toBeTruthy()
  })

  it('без отметки отправка не проходит и показывает ошибку, с отметкой — проходит', () => {
    renderPreview(question('a', 'Имя'), { consent: true })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(screen.getByRole('alert').textContent).toContain('Отметьте согласие')
    expect(screen.queryByRole('button', { name: /Вернуться к форме/ })).toBeNull()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    expect(screen.getByRole('button', { name: /Вернуться к форме/ })).toBeTruthy()
  })

  it('ссылка на документ в превью никуда не ведёт', () => {
    renderPreview(question('a', 'Имя'), { consent: true })
    const link = screen.getByRole('link', { name: 'согласие на обработку персональных данных' })
    // Дефолт клика погашен: переход увёл бы автора с превью. Что клик по ссылке внутри
    // метки не переключает галочку, здесь не проверить: happy-dom переключает её вопреки
    // спецификации, браузеры — нет.
    expect(fireEvent.click(link)).toBe(false)
  })
})
