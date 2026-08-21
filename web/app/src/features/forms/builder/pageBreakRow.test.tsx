// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { type Block, SCHEMA_VERSION, textFromString } from '@entities/formSchema'

import { PageBreakField } from './kinds/pageBreakField'
import { createBuilderStore } from './store'
import { BuilderStoreContext, useBuilderStore } from './storeContext'

// Разделитель страницы: тумблер «Спасибо» и попап имени. Тест DOM-ный, потому что оба
// контрола — про поведение, а не про раскладку: тумблер обязан ПИСАТЬ ФЛАГ (а не
// производную «действует»), имя — коммититься по «Применить», а не по каждому символу.
// Проверить это иначе нельзя: то и другое видно только в документе стора.

afterEach(cleanup)

const doc = (thankYou = false): Block[] => [
  { id: 'q1', groupId: 'g1', type: 'short_text' },
  { id: 'pb', groupId: 'gp', type: 'page_break', ...(thankYou ? { settings: { thankYou: true } } : {}) },
  { id: 'h', groupId: 'g2', type: 'heading', text: textFromString('Готово') },
]

// Блок приезжает из СТОРА, а не снимком: на полотне его отдаёт BlockRow, и с
// зафиксированным пропом подпись не обновилась бы после правки — тест поймал бы
// собственную оснастку, а не продукт.
function Row() {
  const block = useBuilderStore((s) => s.blocks.find((b) => b.id === 'pb'))
  return block ? <PageBreakField block={block} /> : null
}

function renderRow(blocks: Block[]) {
  const store = createBuilderStore()
  store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks })
  const view = render(
    <BuilderStoreContext.Provider value={store}>
      <Row />
    </BuilderStoreContext.Provider>,
  )
  const settingsOf = (id: string) => store.getState().blocks.find((b) => b.id === id)?.settings
  return { ...view, store, settingsOf }
}

describe('тумблер «Страница „Спасибо"»', () => {
  it('стоит на разрыве всегда и включается', () => {
    const { settingsOf } = renderRow(doc())
    const sw = screen.getByRole('switch', { name: 'Страница «Спасибо»' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(settingsOf('pb')?.thankYou).toBe(true)
  })

  // Снятие СТИРАЕТ ключ, а не пишет false: канон пустых значений не хранит, и лишний ключ
  // означал бы третье состояние там, где их два.
  it('снятие стирает ключ, а не пишет false', () => {
    const { settingsOf } = renderRow(doc(true))
    fireEvent.click(screen.getByRole('switch', { name: 'Страница «Спасибо»' }))
    expect(settingsOf('pb')?.thankYou).toBeUndefined()
  })

  // Тумблер показывает ФЛАГ, а не производную: иначе клик по нему на форме, где правило
  // нарушено, выглядел бы как поломка — щёлкнул и сам вернулся.
  it('на странице с вопросом остаётся включённым и объясняет, почему не действует', () => {
    const withQuestion: Block[] = [
      { id: 'q1', groupId: 'g1', type: 'short_text' },
      { id: 'pb', groupId: 'gp', type: 'page_break', settings: { thankYou: true } },
      { id: 'q2', groupId: 'g2', type: 'email' },
    ]
    renderRow(withQuestion)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/на странице есть вопрос/)).toBeTruthy()
  })
})

describe('попап имени страницы', () => {
  const openPopup = () => fireEvent.click(screen.getByRole('button', { name: 'Название страницы' }))

  it('подпись = номер страницы, пока имени нет', () => {
    renderRow(doc())
    expect(screen.getByRole('button', { name: 'Название страницы' }).textContent).toBe('Страница 2')
  })

  it('«Применить» пишет имя, и подпись становится «имя #номер»', () => {
    const { settingsOf } = renderRow(doc())
    openPopup()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Контакты' } })
    // До «Применить» документ не тронут: правка ведётся в черновике попапа.
    expect(settingsOf('pb')?.pageName).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }))
    expect(settingsOf('pb')?.pageName).toBe('Контакты')
    expect(screen.getByRole('button', { name: 'Название страницы' }).textContent).toBe(
      'Контакты #2',
    )
  })

  // Enter — то же, что «Применить»: попап одноцелевой, и тянуться к кнопке мышью после
  // набора имени незачем. Проверяется здесь, а не в браузере: синтетические клавиши в
  // автоматизированной панели до обработчика не доходят.
  it('Enter применяет имя и не доезжает до полотна', () => {
    const { settingsOf } = renderRow(doc())
    openPopup()
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Знакомство' } })
    const notCancelled = fireEvent.keyDown(input, { key: 'Enter' })
    expect(settingsOf('pb')?.pageName).toBe('Знакомство')
    // fireEvent возвращает false, когда обработчик вызвал preventDefault: Enter на
    // полотне вставляет блок ниже, и пустить его туда нельзя.
    expect(notCancelled).toBe(false)
  })

  // У ДЕЙСТВУЮЩЕЙ страницы «Спасибо» номера нет: респондент видит её не шагом, и «#3» на
  // ней означало бы шаг, которого в форме нет.
  it('у страницы «Спасибо» подпись без номера', () => {
    renderRow(doc(true))
    expect(screen.getByRole('button', { name: 'Название страницы' }).textContent).toBe('Спасибо')
  })
})
