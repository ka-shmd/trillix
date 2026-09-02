// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { type FormSchema, textFromString, SCHEMA_VERSION } from '@entities/formSchema'
import { carriesText, isAnswerableType, isCaptionType } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import {
  type ActiveRow,
  ActiveRowApiProvider,
  ActiveRowValueProvider,
  useActiveRowState,
} from './activeRow'
import { BlockRow } from './BlockRow'
import { ChordChips } from './ChordChips'
import { BLOCK_COMMON, chords, GLOBAL, labelFor } from './shortcuts'
import { ShortcutSheet } from './ShortcutSheet'

// Подсказки полотна. С 2026-07-29 (решение владельца) у строки не остаётся ни одного
// чипа-подсказки, кроме ОДНОГО действия — дать голому полю заголовок: это не просто
// напоминание о клавише, а единственный способ взять это действие мышью. Вся карта
// клавиш живёт в шпаргалке Mod+/, и правило прежнее — «перечисляем ровно то, что на
// этой строке работает», поэтому проверяем состав, а не вёрстку.

afterEach(cleanup)

// Полотно теста: настоящие BlockRow под провайдерами активной строки — фокус ставим
// движком, чипы появляются от настоящих focus-событий, как в билдере.
function CanvasBody({
  store,
  engine,
  blocks,
  onActive,
}: {
  store: ReturnType<typeof createBuilderStore>
  engine: ReturnType<typeof createFocusEngine>
  blocks: ReturnType<ReturnType<typeof createBuilderStore>['getState']>['blocks']
  // Активная строка, как её объявила поверхность: часть контракта карты не доезжает
  // до чипов (их потолок — три), а проверять нужно именно объявление.
  onActive: (row: ActiveRow | null) => void
}) {
  const activeRow = useActiveRowState()
  onActive(activeRow.active)
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
  return (
    <BuilderStoreContext.Provider value={store}>
      <FocusEngineProvider value={engine}>
        <ActiveRowApiProvider value={activeRow.api}>
          <ActiveRowValueProvider value={activeRow.active}>
            <DndContext>
              <SortableContext items={blocks.map((b) => b.id)}>
                {blocks.map((b) => (
                  <BlockRow
                    key={b.id}
                    block={b}
                    formId="f"
                    groupHandle={null}
                    // Как в GroupRow: подсказка про Mod+Enter зависит от наличия
                    // отвечаемого блока в группе строки.
                    groupHasAnswer={blocks.some(
                      (x) => x.groupId === b.groupId && isAnswerableType(x.type),
                    )}
                    // Как в GroupRow: голой строке ответа не хватает заголовка —
                    // от этого зависит чип «Mod+Alt+T» и его кликабельность.
                    needsCaption={
                      isAnswerableType(b.type) &&
                      !carriesText(b.type) &&
                      !blocks.some((x) => x.groupId === b.groupId && isCaptionType(x.type))
                    }
                    openMenuOnMount={false}
                    {...handlers}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </ActiveRowValueProvider>
        </ActiveRowApiProvider>
      </FocusEngineProvider>
    </BuilderStoreContext.Provider>
  )
}

function setup(schema: FormSchema) {
  const engine = createFocusEngine()
  const store = createBuilderStore()
  store.getState().hydrate(schema)
  const blocks = store.getState().blocks
  let active: ActiveRow | null = null
  render(
    <CanvasBody
      store={store}
      engine={engine}
      blocks={blocks}
      onActive={(row) => {
        active = row
      }}
    />,
  )
  // Фокус ставим внутри act: чипы появляются от setState в обработчике focus, и без
  // прокачки React проверка увидела бы полотно до перерисовки.
  const focus = (id: string, edge?: 'start' | 'end') => act(() => engine.focusBlock(id, edge))
  return { engine, store, focus, activeRow: (): ActiveRow | null => active }
}

// chips — ярлыки клавиш, показанные сейчас НА ПОЛОТНЕ (у активной строки). После
// 2026-07-29 их бывает ноль или один.
function chips(): string[] {
  return [...document.querySelectorAll('kbd')].map((k) => k.textContent ?? '')
}

// sheetText — что печатает шпаргалка, открытая из строки. Контекст и признаки строки
// шпаргалке отдаёт полотно снимком (см. SlashEditor), поэтому в тесте передаём их
// так же явно.
function sheetText(ctx: Parameters<typeof ShortcutSheet>[0]['ctx'], filters = {}): string {
  cleanup()
  render(<ShortcutSheet ctx={ctx} filters={filters} open onOpenChange={() => {}} />)
  return document.body.textContent ?? ''
}

const QUESTION: FormSchema = {
  schemaVersion: SCHEMA_VERSION,
  blocks: [
    { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Как вас зовут?') },
    { id: 'inp', groupId: 'g1', type: 'short_text' },
    { id: 'bare', groupId: 'g2', type: 'email' },
    { id: 'para', groupId: 'g3', type: 'text', text: textFromString('Просто абзац') },
  ],
}

describe('подсказки у строки: остался один чип', () => {
  it('у собранного вопроса на полотне не показывается ничего', () => {
    const { focus } = setup(QUESTION)
    focus('cap', 'end') // подпись
    expect(chips()).toEqual([])
    focus('inp', 'end') // поле этого вопроса
    expect(chips()).toEqual([])
    focus('para', 'end') // одиночный абзац
    expect(chips()).toEqual([])
  })

  it('голой строке ответа предлагается заголовок — и это единственный чип', () => {
    const { focus } = setup(QUESTION)
    focus('bare', 'end')
    expect(chips()).toEqual(['Ctrl+Alt+T'])
    // Чип — настоящая кнопка, а не aria-hidden украшение: его и ищем ролью, как
    // увидел бы его скринридер.
    expect(screen.getByLabelText('Добавить заголовок вопроса')).toBeTruthy()
  })

  it('чип заголовка кликается мышью и не теряет фокус строки', () => {
    const { focus, store } = setup(QUESTION)
    focus('bare', 'end')

    const chip = screen.getByLabelText('Добавить заголовок вопроса')
    // mousedown обязан быть погашен: иначе фокус уходит со строки, чип гаснет ВМЕСТЕ
    // с кнопкой, и click приходит уже мимо цели (механика TD-22).
    const md = fireEvent.mouseDown(chip)
    expect(md).toBe(false) // preventDefault сработал
    act(() => {
      chip.click()
    })

    const blocks = store.getState().blocks
    const i = blocks.findIndex((b) => b.id === 'bare')
    expect(blocks[i - 1]!.type).toBe('title')
    expect(blocks[i - 1]!.groupId).toBe(blocks[i]!.groupId)
  })

  it('каретка ушла с полотна — чип гаснет', () => {
    const { focus } = setup(QUESTION)
    focus('bare', 'end')
    expect(chips()).toEqual(['Ctrl+Alt+T'])

    act(() => (document.activeElement as HTMLElement).blur())

    expect(chips()).toEqual([])
    expect(screen.queryByLabelText('Добавить заголовок вопроса')).toBeNull()
  })

  it('переход между поверхностями одной строки чип не гасит', () => {
    // Вариант → соседний вариант: focusout приходит перед focusin, и безусловное
    // снятие активности давало бы пустой кадр — чип моргал бы на каждой стрелке по
    // списку. Проверяем именно промежуточное состояние.
    const { focus } = setup({
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
    focus('ch', 'start')
    const [first, second] = [...document.querySelectorAll('input')]
    act(() => fireEvent.focusOut(first!, { relatedTarget: second }))

    expect(chips()).toEqual(['Ctrl+Alt+T'])
  })

  it('строка объявляет о себе то же, что читает шпаргалка', () => {
    // Признаки строки (движется ли она сама, есть ли в группе поле ответа) полотно
    // снимает с активной строки и отдаёт шпаргалке — теперь единственной поверхности
    // карты. Проверяем объявление: разметки у него больше нет.
    const { focus, activeRow } = setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'cap', groupId: 'g1', type: 'title', text: textFromString('Оценка') },
        { id: 'sc', groupId: 'g1', type: 'scale' },
      ],
    })
    focus('sc')
    // Замок «строка ответа в озаглавленной группе не двигается» снят фазой 15 (§4.1).
    expect(activeRow()?.movesRow).toBe(true)
    focus('cap', 'end')
    expect(activeRow()?.hasAnswer).toBe(true)
  })
})

describe('шпаргалка Mod+/ — единственная поверхность карты', () => {
  it('печатает клавиши контекста и вынесенный общий ярус', () => {
    const text = sheetText('option')
    expect(text).toContain('Вариант ответа')
    expect(text).toContain('Выйти из списка') // длинный пункт, в строку не влезавший
    expect(text).toContain('Везде на полотне')
    for (const s of BLOCK_COMMON) expect(text).toContain(s.hint)
    for (const s of GLOBAL) expect(text).toContain(s.hint)
  })

  it('не обещает того, что на этой строке молчит', () => {
    // Mod+Enter из подписи прыгает к полю ответа — а если поля нет, молчит.
    expect(sheetText('text', { hasAnswer: true })).toContain('К полю ответа')
    expect(sheetText('text', { hasAnswer: false })).not.toContain('К полю ответа')
    // На подписи собранного вопроса Alt+↑↓ двигает вопрос целиком, а не строку.
    expect(sheetText('text', { hasAnswer: true, movesRow: false })).not.toContain(
      'Переместить блок',
    )
    // Заголовок предлагается только голой строке ответа: у собранной его не бывает.
    expect(sheetText('field', { needsCaption: true })).toContain('Добавить заголовок')
    expect(sheetText('field')).not.toContain('Добавить заголовок')
  })
})

// Клавиши, напечатанные на самом контроле (кнопка помощи ИИ). Чипы РАЗДЕЛЬНЫЕ: клавиш
// в аккорде столько, сколько нажимать, а слитная плашка «Alt+J» читалась бы названием
// команды. Ярлык при этом берётся из карты — второй копии строки в разметке нет.
describe('аккорд на контроле', () => {
  it('печатается клавишами по отдельности и берёт ярлык из карты', () => {
    const label = labelFor(chords.openChat)
    expect(label).toBe('Alt+J')
    render(<ChordChips label={label ?? ''} />)
    expect([...document.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Alt', 'J'])
  })
})
