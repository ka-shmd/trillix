// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

// Набор написан под <textarea> (хелперы ищут поверхность как
// `document.querySelector('textarea')`) и переписывается под богатый текст этапом 14.3.
// До тех пор он ПРИБИВАЕТ себе поверхность гвоздём, а не читает переключатель пробы:
// иначе прогон краснел бы от того, что кто-то включил пробу для браузера, — то есть от
// состояния чужого рабочего дерева, а не от кода. Проба точно так же прибивает себе
// свою (`spike/richLine.test.tsx`).
vi.mock('./spike/flag', () => ({ RICH_TEXT_SPIKE: false }))
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useStore } from 'zustand'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { type FormSchema, plainText, textFromString } from '@entities/formSchema'
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
      schemaVersion: 3,
      blocks: [
        { id: 'title', groupId: 'g1', type: 'title', text: textFromString('Вопрос') },
        { id: 'head', groupId: 'g2', type: 'heading', text: textFromString('Раздел') },
        { id: 'cons', groupId: 'g3', type: 'consent', text: textFromString('Согласен'), required: true },
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
      schemaVersion: 3,
      blocks: [{ id: 'title', groupId: 'g1', type: 'title', text: textFromString('Привет') }],
    })
    engine.focusBlock('title', 'start')
    expect((el() as HTMLTextAreaElement).selectionStart).toBe(0)
    engine.focusBlock('title', 'end')
    expect((el() as HTMLTextAreaElement).selectionStart).toBe(6)
  })

  it('текстовые поля — фокус на инпут плейсхолдера', () => {
    const { engine } = setup({
      schemaVersion: 3,
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
      schemaVersion: 3,
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
      schemaVersion: 3,
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
      schemaVersion: 3,
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
    expect(handlers.onBackspaceDelete).toHaveBeenCalledWith('sc')
  })

  it('стрелки — обход строк, а не засев', () => {
    const { stop, handlers } = objectStop()
    fireEvent.keyDown(stop, { key: 'ArrowDown', code: 'ArrowDown' })
    expect(handlers.onArrow).toHaveBeenCalledWith('sc', 'down')
    expect(handlers.onAddBelow).not.toHaveBeenCalled()
  })
})

describe('Backspace в первом пустом варианте (TD-30)', () => {
  it('вариант удаляется, а каретка уходит вверх — не в body', () => {
    // Реестровый дефект был не в ветке обработчика, а в её адресате: onLeaveTop
    // приходил пустой заглушкой, вариант исчезал, и фокус проваливался в body.
    // Проверяем именно адресата: строка просит родителя увести каретку наверх
    // (дальше её ведёт stopNeighbor — см. navigation.test.ts).
    const { engine, handlers, store } = setup({
      schemaVersion: 3,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Ваш выбор') },
        {
          id: 'ch',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: '' }] },
        },
      ],
    })
    engine.focusBlock('ch', 'start')
    fireEvent.keyDown(el(), { key: 'Backspace', code: 'Backspace' })
    expect(handlers.onArrow).toHaveBeenCalledWith('ch', 'up')
    // Вариант был последним, поэтому вместе с ним ушёл и сам блок: остаётся голая
    // подпись, в которую автор подсаживает любой блок ответа.
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['cap'])
  })
})

describe('Backspace на инпуте плейсхолдера (§2.1, решение владельца 2026-07-26)', () => {
  it('пустой плейсхолдер → поле удаляется, как объект и как последний вариант', () => {
    const { engine, handlers } = setup({
      schemaVersion: 3,
      blocks: [{ id: 'st', groupId: 'g1', type: 'short_text', settings: {} }],
    })
    engine.focusBlock('st', 'start')
    fireEvent.keyDown(el(), { key: 'Backspace', code: 'Backspace' })
    // Единое поведение поверхностей ответа: «стёрли ответ» = вопрос без поля.
    // Каретку на предыдущую остановку уводит родитель (handleBackspaceDelete).
    expect(handlers.onBackspaceDelete).toHaveBeenCalledWith('st')
    expect(handlers.onArrow).not.toHaveBeenCalled()
  })

  it('плейсхолдер с текстом — Backspace правит текст (не уходит вверх)', () => {
    const { engine, handlers } = setup({
      schemaVersion: 3,
      blocks: [{ id: 'st', groupId: 'g1', type: 'short_text', settings: { placeholder: 'Иван' } }],
    })
    engine.focusBlock('st', 'end')
    fireEvent.keyDown(el(), { key: 'Backspace', code: 'Backspace' })
    expect(handlers.onArrow).not.toHaveBeenCalled()
    expect(handlers.onBackspaceDelete).not.toHaveBeenCalled()
  })
})

// Клавиатурный поток (§3.2, этап 13.2). Строки рендерятся из статичного снапшота
// (setup не пере-подписывается), поэтому наблюдаем НЕ ре-рендер, а результат: спай
// onAddBelow для текстовых маршрутов и store.getState() для операций над документом.
describe('Enter / Shift+Enter на текстовой строке (§3.2)', () => {
  function textRow() {
    const ctx = setup({
      schemaVersion: 3,
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') }],
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
      schemaVersion: 3,
      blocks: [
        { id: 't1', groupId: 'g1', type: 'title', text: textFromString('A') },
        { id: 'f1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 't2', groupId: 'g2', type: 'title', text: textFromString('B') },
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
      schemaVersion: 3,
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
    // Пустой вариант был последним — блок ушёл вместе с ним (здесь он и был всей
    // формой). Новую строку родитель заводит ДО удаления, чтобы ей было от чего
    // считать позицию «после группы».
    expect(handlers.onAddBelow).toHaveBeenCalledWith('ch')
    expect(store.getState().blocks).toHaveLength(0)
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
      schemaVersion: 3,
      blocks: [
        { id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') },
        { id: 'f', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    })
    engine.focusBlock('t', 'end')
    fireEvent.keyDown(el(), { key: 'Backspace', code: 'Backspace', metaKey: true, shiftKey: true })
    expect(handlers.onDeleteBlock).toHaveBeenCalledWith('t')
  })

  it('на варианте choice — зовёт onDeleteBlock с id блока (не варианта)', () => {
    const { engine, handlers } = setup({
      schemaVersion: 3,
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
      schemaVersion: 3,
      blocks: [
        { id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') },
        { id: 'f', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    })
    engine.focusBlock('t', 'end')
    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter', metaKey: true })
    expect(handlers.onAnswerAction).toHaveBeenCalledWith('t')
  })

  it('на картинке — открывает файловый диалог (клик по скрытому input)', () => {
    const { engine, handlers } = setup({
      schemaVersion: 3,
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

// Инлайн-слеш (§3.5, TD-33): «/» — литерал в тексте, меню фильтруется набором,
// несовпадение/Esc закрывают с сохранением текста, выбор вырезает «/»+фильтр и
// применяет тип. В отличие от статичного setup здесь строка ПОДПИСАНА на стор
// (reactiveRow), чтобы value textarea отражал набор — иначе вырезание и конверсия
// (читают текущий block.text) не проверить. Один текстовый (text) блок.
function reactiveRow(text = '') {
  const store = createBuilderStore()
  store.getState().hydrate({
    schemaVersion: 3,
    blocks: [{ id: 't', groupId: 'g1', type: 'text', text: textFromString(text) }],
  })
  const engine = createFocusEngine()
  function Row() {
    const blocks = useStore(store, (s) => s.blocks)
    const b = blocks[0]
    if (!b) return null
    return (
      <BlockRow
        block={b}
        formId="f"
        groupHandle={null}
        openMenuOnMount={false}
        onAddBelow={vi.fn()}
        onInsertBelow={vi.fn()}
        onBackspaceAtStart={vi.fn()}
        onBackspaceDelete={vi.fn()}
        onDeleteBlock={vi.fn()}
        onAnswerAction={vi.fn()}
        onArrow={vi.fn()}
        onRowShift={vi.fn()}
      />
    )
  }
  render(
    <BuilderStoreContext.Provider value={store}>
      <FocusEngineProvider value={engine}>
        <DndContext>
          <SortableContext items={['t']}>
            <Row />
          </SortableContext>
        </DndContext>
      </FocusEngineProvider>
    </BuilderStoreContext.Provider>,
  )
  return { store, engine }
}

// type — эмулирует набор в textarea ПОСИМВОЛЬНО (дописывает к текущему значению),
// каретка в конец. Посимвольность важна: инлайн-слеш триггерится, только когда «/»
// стоит прямо перед кареткой (§3.5), — вставка всей строки разом это не воспроизводит.
function type(value: string) {
  const ta = document.querySelector('textarea')!
  let cur = ta.value
  for (const ch of value.slice(cur.length)) {
    cur += ch
    fireEvent.change(ta, {
      target: { value: cur, selectionStart: cur.length, selectionEnd: cur.length },
    })
  }
}

describe('инлайн-слеш (§3.5, TD-33)', () => {
  it('«/» открывает меню; литерал остаётся в тексте, каретка не покидает строку', () => {
    const { store } = reactiveRow()
    const ta = document.querySelector('textarea')!
    ta.focus()
    type('/')
    expect(plainText(store.getState().blocks[0]!.text)).toBe('/') // «/» в тексте, не проглочен
    expect(document.body.textContent).toContain('Короткий ответ') // меню открыто
    expect(document.activeElement).toBe(ta) // фокус в textarea, а не в поповере
  })

  it('набор после «/» фильтрует пункты', () => {
    reactiveRow()
    type('/email')
    const menu = document.querySelector('[role="listbox"]')!.textContent ?? ''
    expect(menu).toContain('Email')
    expect(menu).not.toContain('Дата')
  })

  it('несовпадение («и/или») закрывает меню, текст сохраняется', () => {
    const { store } = reactiveRow('и')
    type('и/или')
    expect(plainText(store.getState().blocks[0]!.text)).toBe('и/или')
    expect(document.querySelector('[role="listbox"]')).toBeNull() // меню закрыто
  })

  it('Esc закрывает меню, «/» остаётся в тексте', () => {
    const { store } = reactiveRow()
    type('/')
    fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Escape', code: 'Escape' })
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(plainText(store.getState().blocks[0]!.text)).toBe('/')
  })

  it('выбор вырезает «/»+фильтр и конвертирует (Вопрос: подпись+поле)', () => {
    const { store } = reactiveRow()
    type('/email')
    // ArrowDown не нужен — активен первый пункт (q_email, раздел «Вопросы»).
    fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Enter', code: 'Enter' })
    const blocks = store.getState().blocks
    expect(blocks.map((b) => b.type)).toEqual(['title', 'email'])
    expect(plainText(blocks[0]!.text)).toBe('') // «/email» вырезан целиком
  })

  it('текст перед «/» становится подписью поля', () => {
    const { store } = reactiveRow('Возраст')
    type('Возраст/')
    fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Enter', code: 'Enter' })
    const blocks = store.getState().blocks
    expect(blocks[0]!.type).toBe('title')
    expect(plainText(blocks[0]!.text)).toBe('Возраст') // «/» вырезан, текст-подпись сохранён
  })
})

describe('Cmd+. — меню действий блока (§3.3)', () => {
  it('открывает поповер с действиями (дублировать/сменить тип/удалить)', () => {
    const { engine } = setup({
      schemaVersion: 3,
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') }],
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
      schemaVersion: 3,
      blocks: [
        { id: 'ch', groupId: 'g1', type: 'single_choice', settings: { options: [{ id: 'o1', label: 'A' }] } },
      ],
    })
    engine.focusBlock('ch', 'start')
    fireEvent.keyDown(el(), { key: '.', code: 'Period', ctrlKey: true })
    expect(document.body.textContent ?? '').toContain('Дублировать')
  })
})

describe('Mod+Alt+←/→ — ряд (§5, клавиатурное зеркало жеста)', () => {
  const rowKey = (dir: 'left' | 'right') => ({
    key: dir === 'right' ? 'ArrowRight' : 'ArrowLeft',
    code: dir === 'right' ? 'ArrowRight' : 'ArrowLeft',
    ctrlKey: true,
    altKey: true,
  })

  it('на подписи вопроса зовёт перенос — цель выбирает полотно', () => {
    const { engine, handlers } = setup({
      schemaVersion: 3,
      blocks: [
        { id: 'c1', groupId: 'g1', type: 'title', text: textFromString('Имя') },
        { id: 'f1', groupId: 'g1', type: 'short_text' },
      ],
    })
    engine.focusBlock('c1', 'end')
    fireEvent.keyDown(el(), rowKey('right'))
    expect(handlers.onRowShift).toHaveBeenCalledWith('c1', 'right')
    fireEvent.keyDown(el(), rowKey('left'))
    expect(handlers.onRowShift).toHaveBeenCalledWith('c1', 'left')
  })

  it('на инпуте плейсхолдера работает: у голого поля это единственная поверхность', () => {
    const { engine, handlers } = setup({
      schemaVersion: 3,
      blocks: [{ id: 'st', groupId: 'g1', type: 'short_text', settings: {} }],
    })
    engine.focusBlock('st', 'start')
    fireEvent.keyDown(el(), rowKey('right'))
    expect(handlers.onRowShift).toHaveBeenCalledWith('st', 'right')
  })

  it('на объектной остановке (date) переносит ВОПРОС, а не строку', () => {
    const { engine, handlers } = setup({
      schemaVersion: 3,
      blocks: [{ id: 'd', groupId: 'g1', type: 'date', settings: {} }],
    })
    engine.focusBlock('d')
    fireEvent.keyDown(el(), rowKey('right'))
    expect(handlers.onRowShift).toHaveBeenCalledWith('d', 'right')
  })

  it('на варианте choice ставит в ряд ВАРИАНТ; каретка едет с ним', () => {
    const { engine, store, handlers } = setup({
      schemaVersion: 3,
      blocks: [
        {
          id: 'ch',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Да' }, { id: 'o2', label: 'Нет' }] },
        },
      ],
    })
    engine.focusBlock('ch', 'end') // каретка на последнем варианте
    const before = el()
    fireEvent.keyDown(before, rowKey('right'))
    const opts = () => store.getState().blocks[0]!.settings!.options!
    expect(opts()[1]?.column).toBe('right')
    // Вопрос не тронут: жест на варианте — про вариант (§5.1).
    expect(handlers.onRowShift).not.toHaveBeenCalled()
    expect(el()).toBe(before)

    fireEvent.keyDown(el(), rowKey('left'))
    expect(opts()[1]).not.toHaveProperty('column')
  })

  it('на варианте dropdown жест уходит ВОПРОСУ: рядов у нативного списка нет', () => {
    const { engine, store, handlers } = setup({
      schemaVersion: 3,
      blocks: [
        {
          id: 'dd',
          groupId: 'g1',
          type: 'dropdown',
          settings: { options: [{ id: 'o1', label: 'Мск' }, { id: 'o2', label: 'Спб' }] },
        },
      ],
    })
    engine.focusBlock('dd', 'end')
    fireEvent.keyDown(el(), rowKey('right'))
    expect(handlers.onRowShift).toHaveBeenCalledWith('dd', 'right')
    expect(store.getState().blocks[0]!.settings!.options![1]).not.toHaveProperty('column')
  })
})
