// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { type FormSchema, textFromString, SCHEMA_VERSION } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockRow } from './BlockRow'
import { SlashEditor } from './SlashEditor'
import { richCaret } from './richCaret'

// Контракт фокуса полотна (§2.1, §2.4): каждая строка регистрирует фокус-цель, и
// focusBlock(id, edge) ставит document.activeElement на её поверхность — текстовую
// строку подписи (contenteditable с этапа 14.3), инпут плейсхолдера/варианта или
// объектную остановку. Рендерим НАСТОЯЩИЕ
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
  it('подпись/контент/consent — фокус на текстовую поверхность своего текста', () => {
    const { engine } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'title', groupId: 'g1', type: 'title', text: textFromString('Вопрос') },
        { id: 'head', groupId: 'g2', type: 'heading', text: textFromString('Раздел') },
        {
          id: 'cons',
          groupId: 'g3',
          type: 'consent',
          text: textFromString('Согласен'),
          required: true,
        },
      ],
    })
    for (const [id, text] of [
      ['title', 'Вопрос'],
      ['head', 'Раздел'],
      ['cons', 'Согласен'],
    ]) {
      engine.focusBlock(id!, 'end')
      // С этапа 14.3 текстовая поверхность — contenteditable, а не <textarea>. Сам
      // контракт от этого не изменился: движок ставит фокус на поверхность строки, и
      // проверяется именно это, а не тег.
      expect(el().dataset.richLine).toBeDefined()
      expect(el().textContent).toBe(text)
    }
  })

  // Имя строки — единственное, чем за неё можно взяться снаружи: у contenteditable нет
  // ни `placeholder`, ни своего `<label>`, и до этапа 14.5 поверхность была безымянной
  // для скринридера (а e2e держались за исчезнувший `textarea`). У `text` имя обязано
  // совпадать под фокусом и без него — там мигает видимая подсказка, а не имя.
  it('текстовая строка называет себя, и у `text` имя не зависит от фокуса', () => {
    const { engine } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'title', groupId: 'g1', type: 'title', text: textFromString('Вопрос') },
        { id: 'cons', groupId: 'g2', type: 'consent', text: textFromString('Согласен') },
        { id: 'para', groupId: 'g3', type: 'text', text: [] },
      ],
    })
    const named = (name: string) => document.querySelector(`[data-rich-line][aria-label="${name}"]`)
    expect(named('Заголовок вопроса')).not.toBeNull()
    expect(named('Текст согласия')).not.toBeNull()
    // Пустая неактивная строка текста подсказки не показывает — а имя у неё уже есть.
    expect(named('Напечатайте «/», чтобы выбрать блок')).not.toBeNull()
    engine.focusBlock('para', 'end')
    expect(el().getAttribute('aria-label')).toBe('Напечатайте «/», чтобы выбрать блок')
  })

  it('край каретки: start → в начало, end → в конец текста', () => {
    const { engine } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'title', groupId: 'g1', type: 'title', text: textFromString('Привет') }],
    })
    engine.focusBlock('title', 'start')
    expect(richCaret(el()).text().caret).toBe(0)
    expect(richCaret(el()).caretAtStart()).toBe(true)
    engine.focusBlock('title', 'end')
    expect(richCaret(el()).text().caret).toBe(6)
    expect(richCaret(el()).caretAtEnd()).toBe(true)
  })

  it('текстовые поля — фокус на инпут плейсхолдера', () => {
    const { engine } = setup({
      schemaVersion: SCHEMA_VERSION,
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
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        {
          id: 'ch',
          groupId: 'g1',
          type: 'single_choice',
          settings: {
            options: [
              { id: 'o1', label: 'Красный' },
              { id: 'o2', label: 'Синий' },
            ],
          },
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
      schemaVersion: SCHEMA_VERSION,
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
      schemaVersion: SCHEMA_VERSION,
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
      schemaVersion: SCHEMA_VERSION,
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
      schemaVersion: SCHEMA_VERSION,
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
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'st', groupId: 'g1', type: 'short_text', settings: { placeholder: 'Иван' } }],
    })
    engine.focusBlock('st', 'end')
    fireEvent.keyDown(el(), { key: 'Backspace', code: 'Backspace' })
    expect(handlers.onArrow).not.toHaveBeenCalled()
    expect(handlers.onBackspaceDelete).not.toHaveBeenCalled()
  })
})

// Enter на СТРОКЕ ОТВЕТА (решение владельца 2026-08-22). До него поверхность аккорд не
// объявляла вовсе — строка ответа считалась «необязательным листом обхода», и Enter в
// инпуте молча не делал ничего: полотно с неё было не продолжить, не взявшись за мышь.
describe('Enter на инпуте плейсхолдера', () => {
  it('однострочное поле → новая строка ниже', () => {
    const { engine, handlers } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'st', groupId: 'g1', type: 'short_text', settings: {} }],
    })
    engine.focusBlock('st', 'end')
    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter' })
    expect(handlers.onAddBelow).toHaveBeenCalledWith('st')
  })

  it('многострочное поле: Enter — блок ниже, Shift+Enter остаётся textarea', () => {
    // Пара та же, что у текстовой строки, и разводит её тот же `chords.enter`: перенос
    // внутри длинного плейсхолдера цепочка не ловит и отдаёт нативному вводу.
    const { engine, handlers } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'lt', groupId: 'g1', type: 'long_text', settings: {} }],
    })
    engine.focusBlock('lt', 'end')
    expect(el().tagName).toBe('TEXTAREA')

    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter', shiftKey: true })
    expect(handlers.onAddBelow).not.toHaveBeenCalled()

    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter' })
    expect(handlers.onAddBelow).toHaveBeenCalledWith('lt')
  })
})

// Клавиатурный поток (§3.2, этап 13.2). Строки рендерятся из статичного снапшота
// (setup не пере-подписывается), поэтому наблюдаем НЕ ре-рендер, а результат: спай
// onAddBelow для текстовых маршрутов и store.getState() для операций над документом.
describe('Enter / Shift+Enter на текстовой строке (§3.2)', () => {
  function textRow() {
    const ctx = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') }],
    })
    ctx.engine.focusBlock('t', 'end')
    return ctx
  }

  it('Enter → новая строка ниже, без выбора места на самой строке', () => {
    const { handlers } = textRow()
    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter' })
    // Флага «внутрь группы» больше нет: куда ляжет строка, считает startBlock по
    // документу (SlashEditor), а не событие клавиатуры.
    expect(handlers.onAddBelow).toHaveBeenCalledWith('t')
  })

  it('Shift+Enter блока НЕ создаёт — это перенос строки внутри текста', () => {
    const { handlers } = textRow()
    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter', shiftKey: true })
    expect(handlers.onAddBelow).not.toHaveBeenCalled()
  })

  it('Alt+Shift+↓ на подписи — перенос группы целиком (moveGroup)', () => {
    const { store, engine } = setup({
      schemaVersion: SCHEMA_VERSION,
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
      schemaVersion: SCHEMA_VERSION,
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

  // Жест Shift+Enter снят целиком (2026-08-22), а не переехал в текст: на поверхностях
  // без текста он молчит. Пока `chords.enter` был голым матчером, он забирал Shift+Enter
  // себе и вариант рождался — то есть карта клавиш обещала одно, а строка делала другое.
  it('Shift+Enter на варианте не делает ничего', () => {
    const { store, engine } = choiceRow([{ id: 'o1', label: 'A' }])
    engine.focusBlock('ch', 'start')
    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter', shiftKey: true })
    expect(opts(store).map((o) => o.id)).toEqual(['o1'])
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
      schemaVersion: SCHEMA_VERSION,
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
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        {
          id: 'ch',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'A' }] },
        },
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
      schemaVersion: SCHEMA_VERSION,
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
      schemaVersion: SCHEMA_VERSION,
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

// Инлайн-слеш (§3.5, TD-33) переехал в `richLine.test.tsx` — целиком, теми же шестью
// проверками. Причина: с этапа 14.3 они требуют посимвольного набора в contenteditable
// (дописать символ в текстовый узел, подвинуть каретку, послать `input`), а такой
// хелпер — это уже про поверхность, а не про контракт фокуса. Держать его в двух
// наборах значило бы держать две его версии.

describe('Cmd+. — меню действий блока (§3.3)', () => {
  it('открывает поповер с действиями (дублировать/сменить тип/удалить)', () => {
    const { engine } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') }],
    })
    engine.focusBlock('t', 'end')
    fireEvent.keyDown(el(), { key: '.', code: 'Period', metaKey: true })
    const text = document.body.textContent ?? ''
    expect(text).toContain('Дублировать')
    expect(text).toContain('Сменить тип')
    expect(text).toContain('Удалить')
    // Клавиши пунктов печатаются рядом с подписями (решение владельца 2026-09-07).
    // Ярлыки берутся из карты шорткатов, поэтому проверяем факт печати, а не строку:
    // разойтись с картой они не могут, а вот исчезнуть при правке разметки — да.
    expect(text).toContain('Del')
    expect(text).toContain('Alt')
  })

  // Действие из попапа — тот же контракт, что у остального полотна: каретка после него
  // детерминирована. Место опасное: поповер закрывается, а возврат фокуса на его якорь
  // (позиционированный span) мы гасим сами — значит, если действие не поставит каретку,
  // активным элементом станет body. Проверяем самое дешёвое к забыванию — дублирование:
  // у удаления исход фокуса считает полотно (handleDeleteBlock), у смены типа — стор.
  it('«Дублировать» уводит каретку на копию, а не в body', () => {
    const { engine, store } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') }],
    })
    engine.focusBlock('t', 'end')
    fireEvent.keyDown(el(), { key: '.', code: 'Period', metaKey: true })
    const focus = vi.spyOn(engine, 'focusBlock')

    fireEvent.click(screen.getByText('Дублировать'))

    // Строка копии в этом стенде не смонтируется (полотно рендерится из блоков,
    // снятых на setup), поэтому проверяем ЗАПРОС фокуса — то, за что отвечает
    // операция. Довести его до каретки на ещё не смонтированной строке — работа
    // движка (pending), и она проверена своим тестом выше.
    const copy = store.getState().blocks[1]!
    expect(copy.id).not.toBe('t')
    expect(focus).toHaveBeenCalledWith(copy.id, 'end')
  })

  // Три пункта попапа получили аккорды (решение владельца 2026-09-07), и подсказка о
  // них печатается в самих пунктах. Проверяем ЖЕСТ, а не разметку: чипы читают ту же
  // карту, что и обработчики (labelFor), и разойтись с ней не могут — а вот аккорд,
  // забытый в цепочке rowKeys, отличается от работающего только тишиной.
  it('Mod+D дублирует блок прямо со строки, не открывая попап', () => {
    const { engine, store } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') }],
    })
    engine.focusBlock('t', 'end')

    fireEvent.keyDown(el(), { key: 'd', code: 'KeyD', metaKey: true })

    expect(store.getState().blocks).toHaveLength(2)
    expect(document.body.textContent).not.toContain('Дублировать')
  })

  it('Alt+R открывает попап сразу на списке типов', () => {
    const { engine } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') }],
    })
    engine.focusBlock('t', 'end')

    fireEvent.keyDown(el(), { key: 'r', code: 'KeyR', altKey: true })

    // Признак списка типов — поле поиска; общих пунктов в этом виде нет.
    expect(screen.getByPlaceholderText('Тип поля…')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Дублировать')
  })

  // Голый Delete на текстовой строке принадлежит ТЕКСТУ (символ справа от каретки), и
  // блок им не сносится: иначе набор стал бы разрушительным. Работает он в открытом
  // попапе — там каретки в тексте нет, — и ровно это обещает чип у пункта.
  it('Delete: на строке молчит, в открытом попапе удаляет блок', () => {
    const { engine, handlers } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') }],
    })
    engine.focusBlock('t', 'end')

    fireEvent.keyDown(el(), { key: 'Delete', code: 'Delete' })
    expect(handlers.onDeleteBlock).not.toHaveBeenCalled()

    fireEvent.keyDown(el(), { key: '.', code: 'Period', metaKey: true })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Delete', code: 'Delete' })
    expect(handlers.onDeleteBlock).toHaveBeenCalledWith('t')
  })

  it('закрытие попапа без действия (Esc) возвращает каретку на строку', () => {
    const { engine } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: textFromString('Вопрос') }],
    })
    engine.focusBlock('t', 'end')
    fireEvent.keyDown(el(), { key: '.', code: 'Period', metaKey: true })

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' })

    expect(el().dataset.richLine).toBeDefined()
  })

  // То же правило у попапа ВАРИАНТА — и его пришлось чинить: попап варианта
  // onOpenChange только закрывал слой, а возврат Radix на якорь гасил (как у попапа
  // блока), поэтому Esc ронял каретку в body и вся клавиатура полотна умирала до
  // первого клика мышью (находка ревью 16.2б). Комментарий в коде утверждал, что
  // фокус ставит список, — верно для «дублировать»/«удалить», но не для закрытия без
  // действия: там состав вариантов не меняется, и ставить фокус некому.
  it('попап ВАРИАНТА: закрытие без действия возвращает каретку на карточку', () => {
    const { engine } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        {
          id: 'ch',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'A' }] },
        },
      ],
    })
    engine.focusBlock('ch', 'start')
    const optionInput = document.activeElement as HTMLInputElement

    fireEvent.pointerDown(screen.getByLabelText('Настройки варианта'), { clientX: 5, clientY: 5 })
    fireEvent.click(screen.getByLabelText('Настройки варианта'), { clientX: 5, clientY: 5 })
    expect(document.body.textContent ?? '').toContain('Дублировать вариант')

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' })

    expect(document.activeElement).toBe(optionInput)
  })

  it('на варианте choice — открывает меню всего блока', () => {
    const { engine } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        {
          id: 'ch',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'A' }] },
        },
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
      schemaVersion: SCHEMA_VERSION,
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
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'st', groupId: 'g1', type: 'short_text', settings: {} }],
    })
    engine.focusBlock('st', 'start')
    fireEvent.keyDown(el(), rowKey('right'))
    expect(handlers.onRowShift).toHaveBeenCalledWith('st', 'right')
  })

  it('на объектной остановке (date) переносит ВОПРОС, а не строку', () => {
    const { engine, handlers } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'd', groupId: 'g1', type: 'date', settings: {} }],
    })
    engine.focusBlock('d')
    fireEvent.keyDown(el(), rowKey('right'))
    expect(handlers.onRowShift).toHaveBeenCalledWith('d', 'right')
  })

  it('на варианте choice ставит в ряд ВАРИАНТ; каретка едет с ним', () => {
    const { engine, store, handlers } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        {
          id: 'ch',
          groupId: 'g1',
          type: 'single_choice',
          settings: {
            options: [
              { id: 'o1', label: 'Да' },
              { id: 'o2', label: 'Нет' },
            ],
          },
        },
      ],
    })
    engine.focusBlock('ch', 'end') // каретка на последнем варианте
    const before = el()
    fireEvent.keyDown(before, rowKey('right'))
    const opts = () => store.getState().blocks[0]!.settings!.options!
    expect(opts()[1]?.column).toBe(2)
    // Вопрос не тронут: жест на варианте — про вариант (§5.1).
    expect(handlers.onRowShift).not.toHaveBeenCalled()
    expect(el()).toBe(before)

    fireEvent.keyDown(el(), rowKey('left'))
    expect(opts()[1]).not.toHaveProperty('column')
  })

  it('на варианте dropdown жест уходит ВОПРОСУ: рядов у нативного списка нет', () => {
    const { engine, store, handlers } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        {
          id: 'dd',
          groupId: 'g1',
          type: 'dropdown',
          settings: {
            options: [
              { id: 'o1', label: 'Мск' },
              { id: 'o2', label: 'Спб' },
            ],
          },
        },
      ],
    })
    engine.focusBlock('dd', 'end')
    fireEvent.keyDown(el(), rowKey('right'))
    expect(handlers.onRowShift).toHaveBeenCalledWith('dd', 'right')
    expect(store.getState().blocks[0]!.settings!.options![1]).not.toHaveProperty('column')
  })
})

// ОСЬ КОЛОНОК НА ЖИВОМ ПОЛОТНЕ (§12 таблица, строка «Mod+Alt+←/→»; этап 15.6).
//
// Выше жест проверялся на изолированных строках со шпионом вместо стора — там видно, что
// клавиша зовёт команду, но не видно главного риска секции: шаг по оси ПЕРЕНОСИТ блок в
// документе, а колонки — это отдельные контейнеры разметки. Уехав в другую колонку, строка
// меняет DOM-родителя, то есть перемонтируется, и обещание «каретка едет с блоком» держится
// уже не тем, что строку не тронули, а страховкой движка (`last` + `focusLost`). Поэтому
// здесь рендерится настоящий SlashEditor с настоящим стором.
describe('ось колонок: каретка едет с блоком через смену колонки (§11.6)', () => {
  const editor = (...blocks: FormSchema['blocks']) => {
    const store = createBuilderStore()
    store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks })
    const engine = createFocusEngine()
    render(
      <BuilderStoreContext.Provider value={store}>
        <SlashEditor formId="f" engine={engine} onOpenDesign={() => {}} />
      </BuilderStoreContext.Provider>,
    )
    return { store, engine }
  }
  const field = (id: string) => ({
    id,
    groupId: `g_${id}`,
    type: 'short_text' as const,
    settings: {},
  })
  // Чья строка под кареткой: id блока с ближайшего предка-строки (тем же признаком строку
  // узнаёт и сам редактор — activeRow по data-block-id).
  const caretBlock = () => el().closest('[data-block-id]')?.getAttribute('data-block-id') ?? null
  const shift = (dir: 'left' | 'right') =>
    fireEvent.keyDown(el(), {
      key: dir === 'right' ? 'ArrowRight' : 'ArrowLeft',
      code: dir === 'right' ? 'ArrowRight' : 'ArrowLeft',
      ctrlKey: true,
      altKey: true,
    })
  const cols = (store: ReturnType<typeof createBuilderStore>) =>
    store.getState().blocks.map((b) => b.settings?.column ?? '-')

  it('вход в ряд из полной ширины', () => {
    const { store, engine } = editor(field('a'), field('b'))
    engine.focusBlock('b', 'start')

    shift('right')

    expect(cols(store)).toEqual([1, 2])
    expect(caretBlock()).toBe('b')
  })

  it('переезд между колонками секции', () => {
    const { store, engine } = editor(field('a'), field('b'), field('c'))
    engine.focusBlock('b', 'start')
    shift('right') // секция [a | b]
    engine.focusBlock('c', 'start')
    shift('right') // c в правую колонку: [a | b, c]
    expect(cols(store)).toEqual([1, 2, 2])

    shift('left') // c переезжает в левую колонку — это ДРУГАЯ ячейка разметки

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['a', 'c', 'b'])
    expect(caretBlock()).toBe('c')
  })

  it('выход из секции: вопрос уезжает под неё, каретка следом', () => {
    const { store, engine } = editor(field('a'), field('b'), field('c'))
    engine.focusBlock('b', 'start')
    shift('right') // [a | b]
    engine.focusBlock('c', 'start')
    shift('left') // c в левую колонку: [a, c | b]
    expect(cols(store)).toEqual([1, 1, 2])

    shift('left') // c выходит из секции — и уезжает ПОД неё

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['a', 'b', 'c'])
    expect(cols(store)).toEqual([1, 2, '-'])
    expect(caretBlock()).toBe('c')
  })

  it('Enter с ПОСЛЕДНЕЙ строки колонки: новая строка ПОД секцией, каретка в ней', () => {
    // Полноширинная строка в середине секции разрезала бы её пополам (§11.3), поэтому
    // Enter отсюда кладёт новую строку под всей секцией — и каретка обязана уехать
    // туда же, иначе автор печатает вслепую не там, где смотрит. Жмём на абзаце: он
    // сам себе группа, то есть в ней последний.
    const store = createBuilderStore()
    store.getState().hydrate({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'a', groupId: 'ga', type: 'text', text: textFromString('Слева') },
        { id: 'b', groupId: 'gb', type: 'email', settings: {} },
      ],
    })
    const engine = createFocusEngine()
    render(
      <BuilderStoreContext.Provider value={store}>
        <SlashEditor formId="f" engine={engine} onOpenDesign={() => {}} />
      </BuilderStoreContext.Provider>,
    )
    engine.focusBlock('b', 'start')
    shift('right') // секция [a | b]
    expect(cols(store)).toEqual([1, 2])
    engine.focusBlock('a', 'end') // каретка в ЛЕВОЙ колонке

    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter' })

    const ids = store.getState().blocks.map((x) => x.id)
    expect(ids.slice(0, 2)).toEqual(['a', 'b'])
    expect(ids).toHaveLength(3)
    const fresh = ids[2]! // новая строка последняя, то есть под всей секцией
    expect(cols(store)).toEqual([1, 2, '-'])
    expect(caretBlock()).toBe(fresh)
  })

  it('Enter с подписи вопроса в колонке: строка внутрь вопроса, секция цела', () => {
    // Обратная половина того же правила (2026-08-22): не последняя в группе строка
    // рождает соседа ВНУТРИ своей группы, а состав секции считается группами —
    // поэтому колонки от такой вставки не рассыпаются и уводить строку из них незачем.
    const store = createBuilderStore()
    store.getState().hydrate({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'ca', groupId: 'ga', type: 'title', text: textFromString('Имя') },
        { id: 'fa', groupId: 'ga', type: 'short_text', settings: {} },
        { id: 'b', groupId: 'gb', type: 'email', settings: {} },
      ],
    })
    const engine = createFocusEngine()
    render(
      <BuilderStoreContext.Provider value={store}>
        <SlashEditor formId="f" engine={engine} onOpenDesign={() => {}} />
      </BuilderStoreContext.Provider>,
    )
    engine.focusBlock('b', 'start')
    shift('right') // секция [вопрос | b]
    expect(cols(store)).toEqual([1, '-', 2])
    engine.focusBlock('ca', 'end')

    fireEvent.keyDown(el(), { key: 'Enter', code: 'Enter' })

    const ids = store.getState().blocks.map((x) => x.id)
    expect(ids[0]).toBe('ca')
    expect(ids[2]).toBe('fa') // новая строка встала МЕЖДУ подписью и полем
    expect(cols(store)).toEqual([1, '-', '-', 2])
    expect(caretBlock()).toBe(ids[1])
  })
})
