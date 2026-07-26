// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import type { Block, FormSchema } from '@entities/formSchema'
import { isAnswerableType, isCaptionType } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockRow } from './BlockRow'

// Кто чем управляет на полотне (§4 EDITOR, решение владельца 2026-07-26): кластер
// значков «удалить / добавить / перетащить» принадлежит строке, которой можно
// управлять ОТДЕЛЬНО. Строка ответа в озаглавленной группе такой не является —
// вопросом управляет подпись, и значков у поля нет вовсе, как нет и своего Alt+↑↓.
// Голое поле (группа без подписи) значки сохраняет: управлять им больше некому.

afterEach(cleanup)

// Полотно теста: настоящие BlockRow с тем же признаком ownedByCaption, который им
// считает GroupRow, — иначе тест проверял бы не то правило, что живёт в билдере.
function setup(schema: FormSchema) {
  const store = createBuilderStore()
  store.getState().hydrate(schema)
  const engine = createFocusEngine()
  const blocks = store.getState().blocks
  const owned = (b: Block) =>
    isAnswerableType(b.type) && blocks.some((x) => x.groupId === b.groupId && isCaptionType(x.type))
  // Как в GroupRow: чью обязательность показывает строка — поле своё, первая подпись
  // группы — поле своего вопроса.
  const requiredFor = (b: Block, i: number) =>
    isAnswerableType(b.type)
      ? b
      : isCaptionType(b.type) && (i === 0 || blocks[i - 1]!.groupId !== b.groupId)
        ? blocks.find((x) => x.groupId === b.groupId && isAnswerableType(x.type))
        : undefined
  const handlers = {
    onAddBelow: vi.fn(),
    onInsertBelow: vi.fn(),
    onBackspaceAtStart: vi.fn(),
    onBackspaceDelete: vi.fn(),
    onDeleteBlock: vi.fn(),
    onAnswerAction: vi.fn(),
    onArrow: vi.fn(),
    onRowShift: vi.fn(),
  }
  render(
    <BuilderStoreContext.Provider value={store}>
      <FocusEngineProvider value={engine}>
        <DndContext>
          <SortableContext items={blocks.map((b) => b.id)}>
            {blocks.map((b, i) => (
              <BlockRow
                key={b.id}
                block={b}
                formId="f"
                groupHandle={null}
                ownedByCaption={owned(b)}
                requiredFor={requiredFor(b, i)}
                openMenuOnMount={false}
                {...handlers}
              />
            ))}
          </SortableContext>
        </DndContext>
      </FocusEngineProvider>
    </BuilderStoreContext.Provider>,
  )
  return { store, engine, handlers }
}

// row — корень строки блока (у него data-block-id, см. BlockRow).
const row = (id: string) =>
  within(document.querySelector(`[data-block-id="${id}"]`) as HTMLElement)

// controls — подписи кнопок кластера, найденные в строке. Кластер спрятан прозрачностью
// (а не размонтирован), поэтому «нет значков» — это именно отсутствие кнопок в DOM.
const controls = (id: string) =>
  row(id)
    .queryAllByRole('button')
    .map((b) => b.getAttribute('aria-label'))
    .filter((l): l is string => l !== null)

const QUESTION: FormSchema = {
  schemaVersion: 2,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: 'Как вас зовут?' },
    { id: 'inp', groupId: 'g1', type: 'short_text' },
    { id: 'bare', groupId: 'g2', type: 'email' },
    { id: 'para', groupId: 'g3', type: 'text', text: 'Абзац' },
  ],
}

describe('кластер значков строки', () => {
  it('у строки ответа в вопросе значков нет — вопросом управляет подпись', () => {
    setup(QUESTION)
    expect(controls('inp')).not.toContain('Удалить блок')
    expect(controls('inp')).not.toContain('Добавить блок ниже (выбрать тип)')
    expect(controls('inp')).not.toContain('Перетащить блок')
  })

  it('у подписи вопроса значки на месте — это ручка всего вопроса', () => {
    setup(QUESTION)
    expect(controls('cap')).toContain('Удалить вопрос (группу)')
    expect(controls('cap')).toContain('Перетащить блок')
  })

  it('у голого поля значки остаются — управлять им больше некому', () => {
    setup(QUESTION)
    expect(controls('bare')).toContain('Удалить блок')
    expect(controls('bare')).toContain('Перетащить блок')
  })

  it('у одиночного абзаца значки остаются', () => {
    setup(QUESTION)
    expect(controls('para')).toContain('Удалить блок')
  })
})

describe('звёздочка обязательности', () => {
  it('живёт на подписи вопроса, а пишет в его поле', () => {
    const { store } = setup(QUESTION)
    expect(controls('inp')).not.toContain('Сделать вопрос обязательным')

    row('cap').getByLabelText('Сделать вопрос обязательным').click()

    // Носитель флага не поменялся — им остаётся отвечаемый блок группы.
    expect(store.getState().blocks.find((b) => b.id === 'inp')?.required).toBe(true)
    expect(store.getState().blocks.find((b) => b.id === 'cap')?.required).toBeFalsy()
  })

  it('у голого поля остаётся на нём самом — показать её больше негде', () => {
    const { store } = setup(QUESTION)
    row('bare').getByLabelText('Сделать вопрос обязательным').click()
    expect(store.getState().blocks.find((b) => b.id === 'bare')?.required).toBe(true)
  })

  it('у одиночного абзаца её нет — ответов он не собирает', () => {
    setup(QUESTION)
    expect(controls('para')).not.toContain('Сделать вопрос обязательным')
  })
})

describe('значки варианта', () => {
  const CHOICE: FormSchema = {
    schemaVersion: 2,
    blocks: [
      { id: 'cap', groupId: 'g1', type: 'title', text: 'Откуда узнали?' },
      {
        id: 'ch',
        groupId: 'g1',
        type: 'single_choice',
        settings: {
          options: [
            { id: 'o1', label: 'Соцсети' },
            { id: 'o2', label: 'Реклама' },
          ],
        },
      },
    ],
  }

  it('у каждого варианта своя мусорка и своя ручка, крестика больше нет', () => {
    setup(CHOICE)
    // Значки строки choice ушли (ими управляет подпись) — а вариантов стало двое,
    // и у каждого свой полный набор.
    expect(controls('ch')).not.toContain('Удалить блок')
    expect(controls('ch').filter((l) => l === 'Удалить вариант')).toHaveLength(2)
    expect(controls('ch').filter((l) => l === 'Переместить вариант')).toHaveLength(2)
  })

  it('мусорка варианта удаляет именно свой вариант', () => {
    const { store } = setup(CHOICE)
    row('ch').getAllByLabelText('Удалить вариант')[1]!.click()

    const opts = store.getState().blocks.find((b) => b.id === 'ch')?.settings?.options
    expect(opts?.map((o) => o.id)).toEqual(['o1'])
    // Каретка на предыдущий вариант едет тем же removeOptionAt, что и у Backspace
    // (её исход проверяет focusContract): здесь полотно из статичного снапшота и
    // не перерисовывается, поэтому наблюдать перенос фокуса тут нечем.
  })

  it('мусорка последнего варианта уносит блок, а каретку — наверх', () => {
    const { store, handlers } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: 'Откуда узнали?' },
        { id: 'ch', groupId: 'g1', type: 'single_choice', settings: { options: [{ id: 'o1', label: 'Да' }] } },
      ],
    })
    row('ch').getByLabelText('Удалить вариант').click()

    // Остался голый заголовок; каретку наверх просит сама строка — до удаления,
    // пока родителю ещё есть от чего считать соседа.
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['cap'])
    expect(handlers.onArrow).toHaveBeenCalledWith('ch', 'up')
  })
})

// Призрак — пустая строка в конце списка вместо кнопки «Добавить вариант»: вариантом
// не является, в схеме его нет, и весь его смысл — что набор продолжается подряд.
describe('призрак в конце списка вариантов', () => {
  const EMPTY_CHOICE: FormSchema = {
    schemaVersion: 2,
    blocks: [
      { id: 'cap', groupId: 'g1', type: 'title', text: 'Откуда узнали?' },
      { id: 'ch', groupId: 'g1', type: 'single_choice', settings: { options: [] } },
    ],
  }

  it('у пустого блока есть строка для набора, но вариантов в схеме нет', () => {
    const { store } = setup(EMPTY_CHOICE)
    expect(row('ch').getByLabelText('Вариант 1')).toBeTruthy()
    expect(store.getState().blocks.find((b) => b.id === 'ch')?.settings?.options).toEqual([])
    // Значков у призрака нет: удалять и таскать нечего.
    expect(controls('ch')).not.toContain('Удалить вариант')
    expect(controls('ch')).not.toContain('Переместить вариант')
  })

  it('набор в призраке рождает настоящий вариант с этим текстом', () => {
    const { store } = setup(EMPTY_CHOICE)

    fireEvent.change(row('ch').getByLabelText('Вариант 1'), { target: { value: 'С' } })

    const opts = store.getState().blocks.find((b) => b.id === 'ch')?.settings?.options
    expect(opts).toHaveLength(1)
    expect(opts?.[0]?.label).toBe('С')
  })

  it('Backspace в призраке пустого блока уносит блок наверх', () => {
    const { handlers } = setup(EMPTY_CHOICE)

    fireEvent.keyDown(row('ch').getByLabelText('Вариант 1'), {
      key: 'Backspace',
      code: 'Backspace',
    })

    // Тот же обработчик, что у объекта и пустого плейсхолдера: блок уходит, каретка
    // встаёт на предыдущую остановку.
    expect(handlers.onBackspaceDelete).toHaveBeenCalledWith('ch')
  })

  it('Enter в призраке пустого блока — выход из списка, блок уходит', () => {
    const { store, handlers } = setup(EMPTY_CHOICE)

    fireEvent.keyDown(row('ch').getByLabelText('Вариант 1'), { key: 'Enter', code: 'Enter' })

    expect(handlers.onAddBelow).toHaveBeenCalledWith('ch')
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['cap'])
  })

  it('при готовых вариантах призрак стоит следующим номером и блок не трогает', () => {
    const { store, handlers } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: 'Откуда узнали?' },
        {
          id: 'ch',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Соцсети' }] },
        },
      ],
    })
    // Мусорка ровно одна — у настоящего варианта, у призрака её нет.
    expect(controls('ch').filter((l) => l === 'Удалить вариант')).toHaveLength(1)

    fireEvent.keyDown(row('ch').getByLabelText('Вариант 2'), { key: 'Enter', code: 'Enter' })

    expect(handlers.onAddBelow).toHaveBeenCalledWith('ch')
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['cap', 'ch'])
  })
})

describe('Alt+↑↓ на строке ответа', () => {
  it('шкала внутри вопроса не двигается и не отдаёт жест обходу', () => {
    const { store, engine, handlers } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: 'Оценка' },
        { id: 'sc', groupId: 'g1', type: 'scale', settings: { scaleMin: 1, scaleMax: 5 } },
      ],
    })
    const before = store.getState().blocks.map((b) => b.id)

    engine.focusBlock('sc')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })

    expect(store.getState().blocks.map((b) => b.id)).toEqual(before)
    // Гашение важно не меньше самого no-op: непогашенный Alt+↑ провалился бы в
    // обычный обход, и вместо «ничего не произошло» каретка уехала бы на подпись.
    expect(handlers.onArrow).not.toHaveBeenCalled()
  })

  it('голое поле (дата без подписи) двигается как обычный блок', () => {
    const { store, engine } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'para', groupId: 'g1', type: 'text', text: 'Абзац' },
        { id: 'dt', groupId: 'g2', type: 'date', settings: {} },
      ],
    })

    engine.focusBlock('dt')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['dt', 'para'])
  })
})
