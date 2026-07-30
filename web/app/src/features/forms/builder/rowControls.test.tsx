// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { type Block, type FormSchema, textFromString, SCHEMA_VERSION} from '@entities/formSchema'
import { carriesText, isAnswerableType, isCaptionType } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockRow } from './BlockRow'

// Кто чем управляет на полотне (§4 EDITOR + §4.1 спеки фазы 15): кластер значков
// «удалить / добавить / перетащить» принадлежит КАЖДОЙ строке, включая строку ответа
// собранного вопроса — с фазы 15 её можно удалить, утащить и разлучить с подписью.
// Звёздочка обязательности этому не подчиняется: она свойство ВОПРОСА, живёт на
// подписи (как в превью и рендерере) и у поля с подписью не дублируется.

afterEach(cleanup)

// Полотно теста: настоящие BlockRow с тем же requiredFor, который им считает
// GroupRow, — иначе тест проверял бы не то правило, что живёт в билдере.
function setup(schema: FormSchema) {
  const store = createBuilderStore()
  store.getState().hydrate(schema)
  const engine = createFocusEngine()
  const blocks = store.getState().blocks
  const hasCaption = (b: Block) =>
    blocks.some((x) => x.groupId === b.groupId && isCaptionType(x.type))
  // Как в GroupRow: звёздочку показывает первая подпись группы, а у группы без
  // подписи — само поле (показать её больше негде).
  const requiredFor = (b: Block, i: number) =>
    isCaptionType(b.type) && (i === 0 || blocks[i - 1]!.groupId !== b.groupId)
      ? blocks.find((x) => x.groupId === b.groupId && isAnswerableType(x.type))
      : isAnswerableType(b.type) && !hasCaption(b)
        ? b
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
                requiredFor={requiredFor(b, i)}
                // Как в GroupRow: голая строка ответа подсказывает, чего ей не
                // хватает (§4.4 спеки фазы 15); consent исключён — его текст и есть
                // строка вопроса.
                needsCaption={isAnswerableType(b.type) && !carriesText(b.type) && !hasCaption(b)}
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
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Как вас зовут?') },
    { id: 'inp', groupId: 'g1', type: 'short_text' },
    { id: 'bare', groupId: 'g2', type: 'email' },
    { id: 'para', groupId: 'g3', type: 'text', text: textFromString('Абзац') },
  ],
}

describe('кластер значков строки', () => {
  it('у строки ответа в вопросе значки есть — её можно унести отдельно (фаза 15)', () => {
    setup(QUESTION)
    expect(controls('inp')).toContain('Удалить блок')
    expect(controls('inp')).toContain('Добавить блок ниже (выбрать тип)')
    expect(controls('inp')).toContain('Перетащить блок')
  })

  it('мусорка строки ответа сносит поле, а подпись оставляет', () => {
    const { store } = setup(QUESTION)

    row('inp').getByLabelText('Удалить блок').click()

    // Вопрос распался: подпись осталась одиночкой, ждущей поле. Ответы на удалённый
    // блок при этом уже осиротели — но это и есть явный жест автора, а не побочный
    // эффект переноса (о потере заголовка предупреждает captionLoss).
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['cap', 'bare', 'para'])
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

// §4.4 спеки фазы 15: правило «часть типов без подписи не существует» держал только
// редактор, и держал тем, что поле нельзя было увести. Увести теперь можно, поэтому
// правило стало правилом ВСТАВКИ, а голая строка ответа — законным состоянием,
// которое подсказывает, чего ему не хватает. Подсказка у ЛЮБОГО голого поля
// (решение владельца 2026-07-29): безымянным в выгрузке окажется каждое из них, а не
// только типы из requiresCaption.
describe('голая строка ответа', () => {
  const BARE: FormSchema = {
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      { id: 'txt', groupId: 'g1', type: 'short_text', settings: {} },
      { id: 'ok', groupId: 'g2', type: 'consent', text: textFromString('Согласен'), required: true },
      { id: 'cap', groupId: 'g3', type: 'title', text: textFromString('Откуда узнали?') },
      { id: 'ch', groupId: 'g3', type: 'single_choice', settings: { options: [{ id: 'o1', label: 'Да' }] } },
    ],
  }

  it('Mod+Alt+T даёт полю заголовок и уводит на него каретку', () => {
    const { store, engine } = setup(BARE)
    const focus = vi.spyOn(engine, 'focusBlock')

    engine.focusBlock('txt')
    fireEvent.keyDown(document.activeElement!, { code: 'KeyT', key: 't', ctrlKey: true, altKey: true })

    const blocks = store.getState().blocks
    expect(blocks.map((b) => b.type)).toEqual(['title', 'short_text', 'consent', 'title', 'single_choice'])
    // Подпись встала НАД полем и склеилась с ним в вопрос (regroup).
    expect(blocks[0]!.groupId).toBe(blocks[1]!.groupId)
    expect(focus).toHaveBeenLastCalledWith(blocks[0]!.id, 'end')
  })

  it('строке с заголовком жест ничего не делает — второго заголовка не бывает', () => {
    const { store, engine } = setup(BARE)
    const before = store.getState().blocks

    engine.focusBlock('ch')
    fireEvent.keyDown(document.activeElement!, { code: 'KeyT', key: 't', ctrlKey: true, altKey: true })

    // Ни блока, ни шага истории: жест не обещан, значит и не сработал.
    expect(store.getState().blocks).toBe(before)
    expect(store.getState().dirty).toBe(false)
  })

  it('согласию жест не положен — его текст и есть строка вопроса', () => {
    const { store, engine } = setup(BARE)
    const before = store.getState().blocks

    engine.focusBlock('ok')
    fireEvent.keyDown(document.activeElement!, { code: 'KeyT', key: 't', ctrlKey: true, altKey: true })

    expect(store.getState().blocks).toBe(before)
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
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Откуда узнали?') },
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
    // У каждого варианта свой полный набор — поверх кластера самой строки.
    expect(controls('ch').filter((l) => l === 'Удалить вариант')).toHaveLength(2)
    expect(controls('ch').filter((l) => l === 'Переместить вариант')).toHaveLength(2)
  })

  it('редактор показывает тот же глиф, что респондент: чекбокс у «нескольких»', () => {
    setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Что берёте?') },
        {
          id: 'ch',
          groupId: 'g1',
          type: 'multi_choice',
          settings: { options: [{ id: 'o1', label: 'Чай' }] },
        },
      ],
    })
    const card = document.querySelector('[data-block-id="ch"] .rf-option')!
    expect(card.classList.contains('rf-option--check')).toBe(true)
    expect(card.querySelector('.rf-mark--check')).toBeTruthy()
    expect(card.querySelector('.rf-option-key')).toBeNull()
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
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Откуда узнали?') },
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
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Откуда узнали?') },
      { id: 'ch', groupId: 'g1', type: 'single_choice', settings: { options: [] } },
    ],
  }

  it('у пустого блока есть строка для набора, но вариантов в схеме нет', () => {
    const { store } = setup(EMPTY_CHOICE)
    expect(row('ch').getByLabelText('Добавить ответ')).toBeTruthy()
    expect(store.getState().blocks.find((b) => b.id === 'ch')?.settings?.options).toEqual([])
    // Значков у призрака нет: удалять и таскать нечего.
    expect(controls('ch')).not.toContain('Удалить вариант')
    expect(controls('ch')).not.toContain('Переместить вариант')
  })

  it('набор в призраке рождает настоящий вариант с этим текстом', () => {
    const { store } = setup(EMPTY_CHOICE)

    fireEvent.change(row('ch').getByLabelText('Добавить ответ'), { target: { value: 'С' } })

    const opts = store.getState().blocks.find((b) => b.id === 'ch')?.settings?.options
    expect(opts).toHaveLength(1)
    expect(opts?.[0]?.label).toBe('С')
  })

  it('Backspace в призраке пустого блока уносит блок наверх', () => {
    const { handlers } = setup(EMPTY_CHOICE)

    fireEvent.keyDown(row('ch').getByLabelText('Добавить ответ'), {
      key: 'Backspace',
      code: 'Backspace',
    })

    // Тот же обработчик, что у объекта и пустого плейсхолдера: блок уходит, каретка
    // встаёт на предыдущую остановку.
    expect(handlers.onBackspaceDelete).toHaveBeenCalledWith('ch')
  })

  it('Enter в призраке пустого блока — выход из списка, блок уходит', () => {
    const { store, handlers } = setup(EMPTY_CHOICE)

    fireEvent.keyDown(row('ch').getByLabelText('Добавить ответ'), { key: 'Enter', code: 'Enter' })

    expect(handlers.onAddBelow).toHaveBeenCalledWith('ch')
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['cap'])
  })

  it('при готовых вариантах призрак стоит последним и блок не трогает', () => {
    const { store, handlers } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Откуда узнали?') },
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

    fireEvent.keyDown(row('ch').getByLabelText('Добавить ответ'), { key: 'Enter', code: 'Enter' })

    expect(handlers.onAddBelow).toHaveBeenCalledWith('ch')
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['cap', 'ch'])
  })
})

describe('Alt+↑↓ на строке ответа', () => {
  it('шкала уезжает из своего вопроса — жест снят с замка (фаза 15)', () => {
    const { store, engine, handlers } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Оценка') },
        { id: 'sc', groupId: 'g1', type: 'scale', settings: { scaleMin: 1, scaleMax: 5 } },
      ],
    })

    engine.focusBlock('sc')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })

    // Строка ответа уехала ВЫШЕ своей подписи: вопрос распался, шкала осталась голой.
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['sc', 'cap'])
    // Жест по-прежнему гасится, а не проваливается в обычный обход стрелками.
    expect(handlers.onArrow).not.toHaveBeenCalled()
  })

  it('инпут плейсхолдера двигает свою строку — до фазы 15 клавиши там не было', () => {
    const { store, engine } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Имя') },
        { id: 'inp', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    })

    engine.focusBlock('inp')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['inp', 'cap'])
  })

  it('Alt+Shift+↑↓ в инпуте плейсхолдера строкой не двигает — этого он не обещает', () => {
    const { store, engine } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Имя') },
        { id: 'inp', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    })

    engine.focusBlock('inp')
    fireEvent.keyDown(document.activeElement!, {
      key: 'ArrowUp',
      code: 'ArrowUp',
      altKey: true,
      shiftKey: true,
    })

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['cap', 'inp'])
  })

  it('голое поле (дата без подписи) двигается как обычный блок', () => {
    const { store, engine } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'para', groupId: 'g1', type: 'text', text: textFromString('Абзац') },
        { id: 'dt', groupId: 'g2', type: 'date', settings: {} },
      ],
    })

    engine.focusBlock('dt')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['dt', 'para'])
  })
})
