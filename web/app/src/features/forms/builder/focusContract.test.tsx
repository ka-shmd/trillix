// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import type { FormSchema } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockRow } from './BlockRow'

// Контракт фокуса полотна (§2.1, §2.4): каждая строка регистрирует фокус-цель, и
// focusBlock(id, edge) ставит document.activeElement на её поверхность — textarea
// подписи, инпут плейсхолдера/варианта или объектную остановку. Рендерим НАСТОЯЩИЕ
// BlockRow под happy-dom и проверяем activeElement. Так демо-критерий этапа
// («каретка нигде не в body») закрыт быстрым юнитом, а не только e2e.

afterEach(cleanup)

// setup — рендерит полотно из блоков схемы (регруппировка — как в билдере) с реальным
// стором и движком. Обработчики строк — шпионы: проверяем, что клавиши объекта зовут
// правильный колбэк. Возвращает движок и блоки (по id фокусируем).
function setup(schema: FormSchema) {
  const store = createBuilderStore()
  store.getState().hydrate(schema)
  const engine = createFocusEngine()
  const blocks = store.getState().blocks
  const handlers = {
    onAddBelow: vi.fn(),
    onInsertBelow: vi.fn(),
    onBackspaceAtStart: vi.fn(),
    onDeleteObject: vi.fn(),
    onDeleteBlock: vi.fn(),
    onAnswerAction: vi.fn(),
    onArrow: vi.fn(),
  }
  render(
    <BuilderStoreContext.Provider value={store}>
      <FocusEngineProvider value={engine}>
        <DndContext>
          <SortableContext items={blocks.map((b) => b.id)}>
            {blocks.map((b) => (
              <BlockRow
                key={b.id}
                block={b}
                formId="f"
                groupHandle={null}
                openMenuOnMount={false}
                {...handlers}
              />
            ))}
          </SortableContext>
        </DndContext>
      </FocusEngineProvider>
    </BuilderStoreContext.Provider>,
  )
  return { store, engine, blocks, handlers }
}

const el = () => document.activeElement as HTMLElement

describe('контракт фокус-целей строк (§2.1)', () => {
  it('подпись/контент/consent — фокус на textarea своего текста', () => {
    const { engine } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'title', groupId: 'g1', type: 'title', text: 'Вопрос' },
        { id: 'head', groupId: 'g2', type: 'heading', text: 'Раздел' },
        { id: 'cons', groupId: 'g3', type: 'consent', text: 'Согласен', required: true },
      ],
    })
    for (const [id, text] of [
      ['title', 'Вопрос'],
      ['head', 'Раздел'],
      ['cons', 'Согласен'],
    ]) {
      engine.focusBlock(id!, 'end')
      expect(el().tagName).toBe('TEXTAREA')
      expect((el() as HTMLTextAreaElement).value).toBe(text)
    }
  })

  it('край каретки: start → в начало, end → в конец текста', () => {
    const { engine } = setup({
      schemaVersion: 2,
      blocks: [{ id: 'title', groupId: 'g1', type: 'title', text: 'Привет' }],
    })
    engine.focusBlock('title', 'start')
    expect((el() as HTMLTextAreaElement).selectionStart).toBe(0)
    engine.focusBlock('title', 'end')
    expect((el() as HTMLTextAreaElement).selectionStart).toBe(6)
  })

  it('текстовые поля — фокус на инпут плейсхолдера', () => {
    const { engine } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'st', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 'lt', groupId: 'g2', type: 'long_text', settings: {} },
        { id: 'em', groupId: 'g3', type: 'email', settings: {} },
      ],
    })
    engine.focusBlock('st', 'end')
    expect(el().tagName).toBe('INPUT')
    engine.focusBlock('lt', 'end')
    expect(el().tagName).toBe('TEXTAREA') // long_text — многострочный плейсхолдер
    engine.focusBlock('em', 'end')
    expect(el().tagName).toBe('INPUT')
  })

  it('choice — фокус на инпут варианта: start → первый, end → последний', () => {
    const { engine } = setup({
      schemaVersion: 2,
      blocks: [
        {
          id: 'ch',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Красный' }, { id: 'o2', label: 'Синий' }] },
        },
      ],
    })
    engine.focusBlock('ch', 'start')
    expect((el() as HTMLInputElement).value).toBe('Красный')
    engine.focusBlock('ch', 'end')
    expect((el() as HTMLInputElement).value).toBe('Синий')
  })

  it('image/date/scale — фокус на объектную остановку (tabIndex -1)', () => {
    const { engine } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'img', groupId: 'g1', type: 'image', settings: { imageKey: 'ws/x.png' } },
        { id: 'dt', groupId: 'g2', type: 'date', settings: {} },
        { id: 'sc', groupId: 'g3', type: 'scale', settings: { scaleMin: 1, scaleMax: 5 } },
      ],
    })
    for (const id of ['img', 'dt', 'sc']) {
      engine.focusBlock(id)
      expect(el().tagName).toBe('DIV')
      expect(el().getAttribute('tabindex')).toBe('-1')
    }
  })
})

describe('поведение объектной остановки (§2.2)', () => {
  function objectStop() {
    const { engine, handlers } = setup({
      schemaVersion: 2,
      blocks: [{ id: 'sc', groupId: 'g1', type: 'scale', settings: { scaleMin: 1, scaleMax: 5 } }],
    })
    engine.focusBlock('sc')
    return { stop: el(), handlers }
  }

  it('печатный символ → text-блок ниже с засевом', () => {
    const { stop, handlers } = objectStop()
    fireEvent.keyDown(stop, { key: 'ф' })
    expect(handlers.onAddBelow).toHaveBeenCalledWith('sc', { seed: 'ф' })
  })

  it('Enter → пустая строка ниже', () => {
    const { stop, handlers } = objectStop()
    fireEvent.keyDown(stop, { key: 'Enter', code: 'Enter' })
    expect(handlers.onAddBelow).toHaveBeenCalledWith('sc')
  })

  it('«/» → строка ниже с открытым меню', () => {
    const { stop, handlers } = objectStop()
    fireEvent.keyDown(stop, { key: '/' })
    expect(handlers.onAddBelow).toHaveBeenCalledWith('sc', { openMenu: true })
  })

  it('Backspace → удалить объект', () => {
    const { stop, handlers } = objectStop()
    fireEvent.keyDown(stop, { key: 'Backspace', code: 'Backspace' })
    expect(handlers.onDeleteObject).toHaveBeenCalledWith('sc')
  })

  it('стрелки — обход строк, а не засев', () => {
    const { stop, handlers } = objectStop()
    fireEvent.keyDown(stop, { key: 'ArrowDown', code: 'ArrowDown' })
    expect(handlers.onArrow).toHaveBeenCalledWith('sc', 'down')
    expect(handlers.onAddBelow).not.toHaveBeenCalled()
  })
})

describe('Backspace на инпуте плейсхолдера (§3.4)', () => {
  it('пустой плейсхолдер, каретка в начале → удалить блок поля', () => {
    const { engine, handlers } = setup({
      schemaVersion: 2,
      blocks: [{ id: 'st', groupId: 'g1', type: 'short_text', settings: {} }],
    })
    engine.focusBlock('st', 'start')
    fireEvent.keyDown(el(), { key: 'Backspace' })
    expect(handlers.onDeleteObject).toHaveBeenCalledWith('st')
  })

  it('плейсхолдер с текстом — Backspace не удаляет блок (правит текст)', () => {
    const { engine, handlers } = setup({
      schemaVersion: 2,
      blocks: [{ id: 'st', groupId: 'g1', type: 'short_text', settings: { placeholder: 'Иван' } }],
    })
    engine.focusBlock('st', 'end')
    fireEvent.keyDown(el(), { key: 'Backspace' })
    expect(handlers.onDeleteObject).not.toHaveBeenCalled()
  })
})

// Клавиатурный поток (§3.2, этап 13.2). Строки рендерятся из статичного снапшота
// (setup не пере-подписывается), поэтому наблюдаем НЕ ре-рендер, а результат: спай
// onAddBelow для текстовых маршрутов и store.getState() для операций над документом.
describe('Enter / Shift+Enter на текстовой строке (§3.2)', () => {
  function textRow() {
    const ctx = setup({
      schemaVersion: 2,
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: 'Вопрос' }],
    })
    ctx.engine.focusBlock('t', 'end')
    return ctx
  }

  it('Enter → новая строка после группы (inside: false)', () => {
    const { handlers } = textRow()
    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter' })
    expect(handlers.onAddBelow).toHaveBeenCalledWith('t', { inside: false })
  })

  it('Shift+Enter → новая строка внутрь группы (inside: true)', () => {
    const { handlers } = textRow()
    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter', shiftKey: true })
    expect(handlers.onAddBelow).toHaveBeenCalledWith('t', { inside: true })
  })

  it('Alt+Shift+↓ на подписи — перенос группы целиком (moveGroup)', () => {
    const { store, engine } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 't1', groupId: 'g1', type: 'title', text: 'A' },
        { id: 'f1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 't2', groupId: 'g2', type: 'title', text: 'B' },
        { id: 'f2', groupId: 'g2', type: 'email', settings: {} },
      ],
    })
    engine.focusBlock('t1', 'end')
    fireEvent.keyDown(el(), { key: 'ArrowDown', code: 'ArrowDown', altKey: true, shiftKey: true })
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['t2', 'f2', 't1', 'f1'])
  })
})

describe('клавиатура вариантов choice (§3.2, Д5)', () => {
  function choiceRow(options: { id: string; label: string }[]) {
    const ctx = setup({
      schemaVersion: 2,
      blocks: [{ id: 'ch', groupId: 'g1', type: 'single_choice', settings: { options } }],
    })
    return ctx
  }
  const opts = (store: ReturnType<typeof setup>['store']) =>
    store.getState().blocks[0]!.settings!.options!

  it('Enter на варианте → новый вариант сразу после текущего (не в конец)', () => {
    const { store, engine } = choiceRow([
      { id: 'o1', label: 'A' },
      { id: 'o2', label: 'B' },
    ])
    engine.focusBlock('ch', 'start') // каретка на первом варианте
    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter' })
    const ids = opts(store).map((o) => o.id)
    expect(ids).toHaveLength(3)
    expect(ids[0]).toBe('o1')
    expect(ids[2]).toBe('o2') // новый встал между o1 и o2
  })

  it('Enter в пустом последнем варианте → выход из списка (удалить + строка ниже)', () => {
    const { store, engine, handlers } = choiceRow([{ id: 'o1', label: '' }])
    engine.focusBlock('ch', 'end')
    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter' })
    expect(opts(store)).toHaveLength(0) // пустой вариант удалён
    expect(handlers.onAddBelow).toHaveBeenCalledWith('ch') // новая строка после группы
  })

  it('Alt+↓ на варианте → перенос варианта вниз', () => {
    const { store, engine } = choiceRow([
      { id: 'o1', label: 'A' },
      { id: 'o2', label: 'B' },
    ])
    engine.focusBlock('ch', 'start')
    fireEvent.keyDown(el(), { key: 'ArrowDown', code: 'ArrowDown', altKey: true })
    expect(opts(store).map((o) => o.id)).toEqual(['o2', 'o1'])
  })
})

describe('Cmd+Shift+Backspace — явное удаление (§3.4)', () => {
  it('на подписи — зовёт onDeleteBlock с id (родитель сносит группу)', () => {
    const { engine, handlers } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 't', groupId: 'g1', type: 'title', text: 'Вопрос' },
        { id: 'f', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    })
    engine.focusBlock('t', 'end')
    fireEvent.keyDown(el(), { key: 'Backspace', code: 'Backspace', metaKey: true, shiftKey: true })
    expect(handlers.onDeleteBlock).toHaveBeenCalledWith('t')
  })

  it('на варианте choice — зовёт onDeleteBlock с id блока (не варианта)', () => {
    const { engine, handlers } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'ch', groupId: 'g1', type: 'single_choice', settings: { options: [{ id: 'o1', label: 'A' }] } },
      ],
    })
    engine.focusBlock('ch', 'start')
    fireEvent.keyDown(el(), { key: 'Backspace', code: 'Backspace', ctrlKey: true, shiftKey: true })
    expect(handlers.onDeleteBlock).toHaveBeenCalledWith('ch')
  })
})

describe('Cmd/Ctrl+Enter — действие над ответом (§3.2)', () => {
  it('с подписи — зовёт onAnswerAction с id (родитель прыгает к контролу)', () => {
    const { engine, handlers } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 't', groupId: 'g1', type: 'title', text: 'Вопрос' },
        { id: 'f', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    })
    engine.focusBlock('t', 'end')
    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter', metaKey: true })
    expect(handlers.onAnswerAction).toHaveBeenCalledWith('t')
  })

  it('на картинке — открывает файловый диалог (клик по скрытому input)', () => {
    const { engine, handlers } = setup({
      schemaVersion: 2,
      blocks: [{ id: 'img', groupId: 'g1', type: 'image', settings: {} }],
    })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    engine.focusBlock('img')
    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter', ctrlKey: true })
    expect(click).toHaveBeenCalled()
    // Объект не должен трактовать это как обычный Enter (строка ниже).
    expect(handlers.onAddBelow).not.toHaveBeenCalled()
  })
})

describe('Cmd+. — меню действий блока (§3.3)', () => {
  it('открывает поповер с действиями (дублировать/сменить тип/удалить)', () => {
    const { engine } = setup({
      schemaVersion: 2,
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: 'Вопрос' }],
    })
    engine.focusBlock('t', 'end')
    fireEvent.keyDown(el(), { key: '.', code: 'Period', metaKey: true })
    const text = document.body.textContent ?? ''
    expect(text).toContain('Дублировать')
    expect(text).toContain('Сменить тип')
    expect(text).toContain('Удалить')
  })

  it('на варианте choice — открывает меню всего блока', () => {
    const { engine } = setup({
      schemaVersion: 2,
      blocks: [
        { id: 'ch', groupId: 'g1', type: 'single_choice', settings: { options: [{ id: 'o1', label: 'A' }] } },
      ],
    })
    engine.focusBlock('ch', 'start')
    fireEvent.keyDown(el(), { key: '.', code: 'Period', ctrlKey: true })
    expect(document.body.textContent ?? '').toContain('Дублировать')
  })
})
