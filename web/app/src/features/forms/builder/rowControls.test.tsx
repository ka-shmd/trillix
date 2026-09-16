// @vitest-environment happy-dom
import { type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'

import { type Block, type FormSchema, textFromString, SCHEMA_VERSION } from '@entities/formSchema'
import { isAnswerableType, isCaptionType } from '@entities/formSchema'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { ActiveRowApiProvider, ActiveRowValueProvider, useActiveRowState } from './activeRow'
import { BlockRow } from './BlockRow'

// Кто чем управляет на полотне (§4 EDITOR + §4.1 спеки фазы 15): кластер значков
// «удалить / добавить / перетащить» принадлежит КАЖДОЙ строке, включая строку ответа
// собранного вопроса — с фазы 15 её можно удалить, утащить и разлучить с подписью.
// Звёздочка обязательности этому не подчиняется: она свойство ВОПРОСА, живёт на
// подписи (как в превью и рендерере) и у поля с подписью не дублируется.

afterEach(cleanup)

// Активная строка объявляется через focusin, и в happy-dom нативный el.focus() его не
// поднимает: React слушает focusin в корне, а happy-dom шлёт только non-bubbling focus.
// Поэтому активность в тестах ставится событием, а не движком фокуса.
const activate = (el: Element) => fireEvent.focusIn(el)

// Полотно теста: настоящие BlockRow с тем же requiredFor, который им считает
// GroupRow, — иначе тест проверял бы не то правило, что живёт в билдере.
// Групповая ручка: её в полотне даёт GroupRow подписи мульти-группы (драг тащит весь
// вопрос). В тестах подсовывается спаем — чтобы видеть, доходит ли до неё нажатие.
type GroupHandle = NonNullable<ComponentProps<typeof BlockRow>['groupHandle']>

function setup(schema: FormSchema, groupHandle: GroupHandle | null = null) {
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
  // Провайдеры активной строки — как в полотне: без них строка не может объявить
  // себя активной, а от активности вопроса зависит призрак в конце списка вариантов.
  // Отдельный компонент, потому что useActiveRowState — хук.
  function Harness() {
    const activeRow = useActiveRowState()
    return (
      <BuilderStoreContext.Provider value={store}>
        <FocusEngineProvider value={engine}>
          <ActiveRowApiProvider value={activeRow.api}>
            <ActiveRowValueProvider value={activeRow.active}>
              <DndContext>
                <SortableContext items={blocks.map((b) => b.id)}>
                  {blocks.map((b, i) => (
                    <BlockRow
                      key={b.id}
                      block={b}
                      formId="f"
                      groupHandle={isCaptionType(b.type) ? groupHandle : null}
                      requiredFor={requiredFor(b, i)}
                      // Как в GroupRow: голая строка ответа подсказывает, чего ей не
                      // хватает (§4.4 спеки фазы 15).
                      needsCaption={isAnswerableType(b.type) && !hasCaption(b)}
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
  render(<Harness />)
  return { store, engine, handlers }
}

// row — корень строки блока (у него data-block-id, см. BlockRow).
const row = (id: string) => within(document.querySelector(`[data-block-id="${id}"]`) as HTMLElement)

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
  // ПОГАШЕННЫЙ КЛАСТЕР ПРОЗРАЧЕН ДЛЯ УКАЗАТЕЛЯ (2026-08-22, жалоба владельца: «значки
  // появляются, когда наводишь на место, где они должны быть»). Кластер лежит ВНЕ бокса
  // строки, оставаясь её потомком, поэтому без этого класса он сам себе делает
  // group-hover — и заодно отбирает жёлоб у ручки ширины. Проверяется классом: :hover в
  // happy-dom не считается, а правило здесь чисто CSS'ное.
  it('невидимый кластер не ловит указатель, показанный — ловит', () => {
    setup(QUESTION)
    const cluster = row('inp').getByLabelText('Удалить блок').parentElement!
    expect(cluster.className).toContain('pointer-events-none')
    expect(cluster.className).toContain('group-hover:pointer-events-auto')
    expect(cluster.className).toContain('group-focus-within:pointer-events-auto')
    // Курсор, ушедший со строки к значкам, держит их меткой строки (clusterAim.ts).
    expect(cluster.className).toContain('group-data-[aim]:pointer-events-auto')
  })

  it('у строки ответа в вопросе значки есть — её можно унести отдельно (фаза 15)', () => {
    setup(QUESTION)
    expect(controls('inp')).toContain('Удалить блок')
    expect(controls('inp')).toContain('Добавить блок ниже (выбрать тип)')
    expect(controls('inp')).toContain('Настройки блока')
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
    expect(controls('cap')).toContain('Настройки блока')
  })

  it('у голого поля значки остаются — управлять им больше некому', () => {
    setup(QUESTION)
    expect(controls('bare')).toContain('Удалить блок')
    expect(controls('bare')).toContain('Настройки блока')
  })

  it('у одиночного абзаца значки остаются', () => {
    setup(QUESTION)
    expect(controls('para')).toContain('Удалить блок')
  })
})

// Грип — две роли на одной ручке (фаза 16, §4.1 спеки): тащим — перенос, кликаем —
// настройки. Так ведёт себя Notion, и вход бесплатен: порог активации сенсора и так
// стоял затем, «чтобы клик по ручке не начинал перетаскивание». Доделать пришлось одно —
// НЕ считать настройками хвостовой click, который браузер шлёт по mouseup после
// настоящего драга: без этого попап открывался бы после каждого перетаскивания.
describe('грип: клик — настройки, перетаскивание — перенос', () => {
  const grip = (id: string) => row(id).getByLabelText('Настройки блока')

  // Жест мышью: нажали в точке from, отпустили (и кликнули) в точке to.
  function gesture(el: HTMLElement, from: [number, number], to: [number, number]) {
    fireEvent.pointerDown(el, { clientX: from[0], clientY: from[1] })
    fireEvent.click(el, { clientX: to[0], clientY: to[1] })
  }

  it('клик без сдвига открывает настройки блока', () => {
    setup(QUESTION)

    gesture(grip('inp'), [10, 10], [10, 10])

    // Попап порталится из строки — ищем по всему документу.
    expect(screen.getByText('Дублировать')).toBeTruthy()
  })

  // Свой onPointerDown у грипа стоит после спреда listeners и потому ПЕРЕБИВАЕТ
  // одноимённый обработчик dnd-kit — тот самый, которым сенсор начинает драг. Ошибка
  // молчаливая: типы её не видят, тесты про клик тоже (клик работает как ни в чём не
  // бывало), а блоки просто перестают таскаться. Проверяем на групповой ручке —
  // слушатели у обоих случаев берутся из одной переменной.
  it('нажатие на грип доходит до слушателей dnd-kit — драг не съеден', () => {
    const onPointerDown = vi.fn()
    setup(QUESTION, {
      attributes: {},
      listeners: { onPointerDown },
    } as unknown as GroupHandle)

    fireEvent.pointerDown(row('cap').getByLabelText('Настройки вопроса'), {
      clientX: 10,
      clientY: 10,
    })

    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })

  it('click после перетаскивания настройки НЕ открывает', () => {
    setup(QUESTION)

    // Сдвиг больше порога активации сенсора — этот жест был драгом, а click у него
    // хвостовой.
    gesture(grip('inp'), [10, 10], [60, 24])

    expect(screen.queryByText('Дублировать')).toBeNull()
  })
})

// Субъект настроек (фаза 16, §4.2 спеки): попап, открытый с ПОДПИСИ собранного вопроса,
// адресован полю этого вопроса — его тип, его обязательность. Общие действия остаются у
// строки, а у подписи «строка» и значит «вопрос целиком»: она владеет группой во всех
// прочих жестах.
describe('субъект настроек: подпись правит поле своего вопроса', () => {
  const openMenu = (id: string, label: string) => {
    fireEvent.pointerDown(row(id).getByLabelText(label), { clientX: 10, clientY: 10 })
    fireEvent.click(row(id).getByLabelText(label), { clientX: 10, clientY: 10 })
  }

  // Один и тот же тип стоит в двух разделах меню («Вопросы» — бандл с подписью,
  // «Отдельные поля» — голое поле), поэтому выбираем ВНУТРИ раздела: без этого тест
  // не отличал бы вставку вопроса от смены типа поля.
  const pick = (section: string, label: string) => {
    const group = screen.getByText(section).closest('[cmdk-group]') as HTMLElement
    fireEvent.click(within(group).getByText(label))
  }

  it('смена типа с подписи меняет тип ПОЛЯ, а не плодит второй вопрос', () => {
    const { store } = setup(QUESTION)

    openMenu('cap', 'Настройки блока')
    fireEvent.click(screen.getByText('Сменить тип'))
    pick('Вопросы', 'Длинный ответ')

    const blocks = store.getState().blocks
    // Состав документа не изменился: тот же вопрос, у него сменился тип ответа.
    expect(blocks.map((b) => b.id)).toEqual(['cap', 'inp', 'bare', 'para'])
    expect(blocks.find((b) => b.id === 'inp')?.type).toBe('long_text')
  })

  it('дублирование с подписи копирует вопрос целиком', () => {
    const { store } = setup(QUESTION)

    openMenu('cap', 'Настройки блока')
    fireEvent.click(screen.getByText('Дублировать'))

    const types = store.getState().blocks.map((b) => b.type)
    // Копия вопроса встала сразу за оригиналом: подпись + поле, а не одинокая подпись
    // вплотную к чужому вопросу.
    expect(types).toEqual(['title', 'short_text', 'title', 'short_text', 'email', 'text'])
  })

  // Находка ревью этапа: у строки ответа ВНУТРИ озаглавленного вопроса субъект — она
  // сама, и попап обязан менять её тип. Через правило вставки этот путь шёл в
  // makeQuestion/makeField, а те для блока внутри группы кладут новый блок НИЖЕ, не
  // трогая исходный, — «сменить тип» не меняло ничего и плодило второй вопрос.
  it('смена типа со строки ответа в вопросе меняет ЕЁ тип', () => {
    const { store } = setup(QUESTION)

    openMenu('inp', 'Настройки блока')
    fireEvent.click(screen.getByText('Сменить тип'))
    pick('Вопросы', 'Длинный ответ')

    const blocks = store.getState().blocks
    expect(blocks.map((b) => b.id)).toEqual(['cap', 'inp', 'bare', 'para'])
    expect(blocks.find((b) => b.id === 'inp')?.type).toBe('long_text')
  })

  // Обязательность (фаза 21) — строка настроек с тремя состояниями вместо прежнего
  // пункта «Сделать обязательным»: required и requiredIf схема запрещает вместе, и
  // переключатель, из которого невыразимо «по условию», собрал бы документ, который
  // сервер отвергнет. Проверяем здесь, а не в focusContract: строка показывается только
  // тому ряду, который представляет поле вопроса (requiredFor), а его считает этот стенд.
  //
  // Значение выбирается не кликом: Radix Select в happy-dom не открывается (портал плюс
  // pointer-события). Что выбор делает с документом — в модели (logic/visibility.test).
  it('обязательность правит строка настроек, адресованная полю вопроса', () => {
    setup(QUESTION)

    openMenu('cap', 'Настройки блока')

    const popup = document.querySelector('[data-slot="popover-content"]') as HTMLElement
    expect(within(popup).getByLabelText('Обязательность вопроса')).toBeTruthy()
  })

  // Правило закрытия попапа: действия, уводящие каретку, помечают себя, остальное (Esc,
  // клик мимо) возвращает её на свою строку — иначе каретка падает в body, потому что
  // возврат Radix на якорь мы гасим сами. Находка ревью этапа 16.
  it('Esc из попапа возвращает каретку на строку, а не роняет в body', () => {
    setup(QUESTION)

    openMenu('cap', 'Настройки блока')
    const popup = document.querySelector('[data-slot="popover-content"]') as HTMLElement
    fireEvent.keyDown(popup, { key: 'Escape', code: 'Escape' })

    const caret = document.activeElement as HTMLElement
    expect(caret.dataset.richLine).toBeDefined()
    expect(caret.textContent).toBe('Как вас зовут?')
  })

  it('на голой строке ответа субъект — она сама', () => {
    const { store } = setup(QUESTION)

    openMenu('bare', 'Настройки блока')
    fireEvent.click(screen.getByText('Сменить тип'))
    // Тип без обязательного заголовка: у требующих его (шкала, списки) «отдельное
    // поле» приезжает вопросом — это правило ВСТАВКИ фазы 13, не субъект настроек.
    pick('Отдельные поля', 'Длинный ответ')

    const blocks = store.getState().blocks
    expect(blocks.find((b) => b.id === 'bare')?.type).toBe('long_text')
    expect(blocks.map((b) => b.id)).toEqual(['cap', 'inp', 'bare', 'para'])
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
      { id: 'cap', groupId: 'g3', type: 'title', text: textFromString('Откуда узнали?') },
      {
        id: 'ch',
        groupId: 'g3',
        type: 'single_choice',
        settings: { options: [{ id: 'o1', label: 'Да' }] },
      },
    ],
  }

  it('Mod+Alt+T даёт полю заголовок и уводит на него каретку', () => {
    const { store, engine } = setup(BARE)
    const focus = vi.spyOn(engine, 'focusBlock')

    engine.focusBlock('txt')
    fireEvent.keyDown(document.activeElement!, {
      code: 'KeyT',
      key: 't',
      ctrlKey: true,
      altKey: true,
    })

    const blocks = store.getState().blocks
    expect(blocks.map((b) => b.type)).toEqual([
      'title',
      'short_text',
      'title',
      'single_choice',
    ])
    // Подпись встала НАД полем и склеилась с ним в вопрос (regroup).
    expect(blocks[0]!.groupId).toBe(blocks[1]!.groupId)
    expect(focus).toHaveBeenLastCalledWith(blocks[0]!.id, 'end')
  })

  it('строке с заголовком жест ничего не делает — второго заголовка не бывает', () => {
    const { store, engine } = setup(BARE)
    const before = store.getState().blocks

    engine.focusBlock('ch')
    fireEvent.keyDown(document.activeElement!, {
      code: 'KeyT',
      key: 't',
      ctrlKey: true,
      altKey: true,
    })

    // Ни блока, ни шага истории: жест не обещан, значит и не сработал.
    expect(store.getState().blocks).toBe(before)
    expect(store.getState().dirty).toBe(false)
  })
})

// Звёздочка — индикатор с одним действием, а не двухпозиционный переключатель: есть
// только у обязательного вопроса и только снимает обязательность.
describe('звёздочка обязательности', () => {
  const STAR = 'Обязательный вопрос — снять'
  const REQUIRED: FormSchema = {
    ...QUESTION,
    blocks: QUESTION.blocks.map((b) =>
      b.id === 'inp' || b.id === 'bare' ? { ...b, required: true } : b,
    ),
  }

  it('живёт на подписи вопроса, а пишет в его поле', () => {
    const { store } = setup(REQUIRED)
    expect(controls('inp')).not.toContain(STAR)

    row('cap').getByLabelText(STAR).click()

    // Носитель флага не поменялся — им остаётся отвечаемый блок группы.
    expect(store.getState().blocks.find((b) => b.id === 'inp')?.required).toBe(false)
    expect(store.getState().blocks.find((b) => b.id === 'cap')?.required).toBeFalsy()
  })

  it('у голого поля остаётся на нём самом — показать её больше негде', () => {
    const { store } = setup(REQUIRED)
    row('bare').getByLabelText(STAR).click()
    expect(store.getState().blocks.find((b) => b.id === 'bare')?.required).toBe(false)
  })

  // Якорь кластера у голого поля — .rf-field-wrap, коробка ширины САМОГО поля. Прицепи
  // его к строке — и он встанет у правого края колонки (700px), в полуметре пустоты от
  // поля, упирающегося в --rf-input-max (320px).
  it('у голого поля кластер висит на обёртке поля, а не у края строки', () => {
    setup(REQUIRED)
    expect(row('bare').getByLabelText(STAR).closest('.rf-field-wrap')).toBeTruthy()
  })

  // БЕЙДЖ В УГЛУ, А НЕ ХВОСТ СПРАВА (решение владельца 2026-08-22). Прежнее место
  // (`left-full`) лежало за правым краем якоря: у поля в ряду это жёлоб с ручкой
  // ширины, у объектной остановки — вовсе соседняя колонка.
  it('у голого поля звёздочка висит бейджем в правом верхнем углу блока', () => {
    setup(REQUIRED)
    const marks = row('bare').getByLabelText(STAR).parentElement!
    expect(marks.className).toContain('absolute')
    expect(marks.className).toContain('right-1')
    expect(marks.className).not.toContain('left-full')
  })

  it('у вопроса с подписью кластер инлайн, в обёртку поля не уезжает', () => {
    setup(REQUIRED)
    expect(row('cap').getByLabelText(STAR).closest('.rf-field-wrap')).toBeNull()
  })

  it('у необязательного вопроса её нет вовсе — ни на подписи, ни у голого поля', () => {
    setup(QUESTION)
    expect(controls('cap')).not.toContain(STAR)
    expect(controls('bare')).not.toContain(STAR)
  })

  it('у одиночного абзаца её нет — ответов он не собирает', () => {
    setup(REQUIRED)
    expect(controls('para')).not.toContain(STAR)
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

  it('ряд-контейнер стоит ВСЕГДА, даже у списка из одной колонки', () => {
    // Обёртка, появляющаяся с началом драга, ремаунтила бы карточку вместе с её инпутом
    // (тип узла посреди жеста менять нельзя, EDITOR.md §5.1), поэтому .rf-row стоит и у
    // ряда из одного. Плата — колонка обязана ОБНИМАТЬ карточку: без этого .rf-cell
    // растянет её до потолка --rf-input-max, и одинокий вариант станет шире, чем у
    // респондента.
    setup(CHOICE)
    const list = document.querySelector('[data-block-id="ch"] .rf-options')!
    const rows = list.querySelectorAll(':scope > .rf-row')
    expect(rows).toHaveLength(2) // два варианта — два полноширинных ряда
    for (const row of rows) {
      const cell = row.querySelector(':scope > .rf-cell')!
      expect(cell.className).toContain('[align-items:var(--rf-align-items)]')
      expect(cell.querySelector('[data-option-id]')).toBeTruthy()
    }
  })

  it('у каждого варианта своя мусорка и свой грип-настройки, крестика больше нет', () => {
    setup(CHOICE)
    // У каждого варианта свой полный набор. С фазы 16 грип варианта называет КЛИК
    // («Настройки варианта»), потому что клик открывает попап, а перетаскивание
    // осталось прежним жестом той же ручки.
    expect(controls('ch').filter((l) => l === 'Удалить вариант')).toHaveLength(2)
    expect(controls('ch').filter((l) => l === 'Настройки варианта')).toHaveLength(2)
  })

  // Решение владельца 6 (разворот 15.2): у строки выбора в озаглавленном вопросе
  // собственного кластера нет — ни мусорки, ни «+», ни грипа. Управление списком живёт
  // у карточек вариантов, самой строкой управляет вопрос (её подпись).
  it('у строки выбора в вопросе своего кластера нет', () => {
    setup(CHOICE)
    expect(controls('ch')).not.toContain('Удалить блок')
    expect(controls('ch')).not.toContain('Настройки блока')
    expect(controls('ch')).not.toContain('Добавить блок ниже (выбрать тип)')
  })

  // Попап варианта (решение владельца 7): два пункта, и оба нужны — с решением 6
  // карточка стала единственным местом, где списком управляют.
  it('клик по грипу варианта открывает попап, и «Дублировать» кладёт копию под ним', () => {
    const { store } = setup(CHOICE)
    const grip = row('ch').getAllByLabelText('Настройки варианта')[0]!

    fireEvent.pointerDown(grip, { clientX: 10, clientY: 10 })
    fireEvent.click(grip, { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByText('Дублировать вариант'))

    const options = store.getState().blocks.find((b) => b.id === 'ch')!.settings!.options!
    expect(options.map((o) => o.label)).toEqual(['Соцсети', 'Соцсети', 'Реклама'])
    // Копия — своя сущность: ответы ключуются id варианта, и общий id присвоил бы
    // копии чужие ответы.
    expect(options[1]!.id).not.toBe(options[0]!.id)
  })

  // Строка выбора БЕЗ подписи — сама себе вопрос (§4.2), и снятый кластер оставил бы
  // её без единого способа управления мышью.
  it('у голой строки выбора кластер остаётся', () => {
    setup({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        {
          id: 'lone',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Соцсети' }] },
        },
      ],
    })
    expect(controls('lone')).toContain('Удалить блок')
    expect(controls('lone')).toContain('Настройки блока')
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
        {
          id: 'ch',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Да' }] },
        },
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

  const FILLED_CHOICE: FormSchema = {
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

  it('клик по строке призрака рождает пустой вариант', () => {
    const { store } = setup(EMPTY_CHOICE)

    // Кликают по строке, а не по 20-пиксельному глифу: жест принимает вся строка,
    // поэтому и проверяется клик по её содержимому.
    fireEvent.click(row('ch').getByLabelText('Добавить ответ'))

    const opts = store.getState().blocks.find((b) => b.id === 'ch')?.settings?.options
    expect(opts).toHaveLength(1)
    expect(opts?.[0]?.label).toBe('')
  })

  it('глиф будущего варианта у призрака ВИДЕН', () => {
    setup(EMPTY_CHOICE)
    // У «одного из списка» глиф — бейдж со следующей буквой; список пуст, значит «A».
    expect(row('ch').getByText('A')).toBeTruthy()
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
    const { store, handlers } = setup(FILLED_CHOICE)
    // Мусорка ровно одна — у настоящего варианта, у призрака её нет.
    expect(controls('ch').filter((l) => l === 'Удалить вариант')).toHaveLength(1)

    activate(row('ch').getByLabelText('Вариант 1'))
    fireEvent.keyDown(row('ch').getByLabelText('Добавить ответ'), { key: 'Enter', code: 'Enter' })

    expect(handlers.onAddBelow).toHaveBeenCalledWith('ch')
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['cap', 'ch'])
  })

  // Призрак — приглашение автору, который сейчас в этом вопросе, а не постоянная
  // деталь формы: у неактивного вопроса список кончается последним вариантом.
  describe('видимость призрака', () => {
    it('вопрос не активен — призрака нет', () => {
      setup(FILLED_CHOICE)
      expect(row('ch').queryByLabelText('Добавить ответ')).toBeNull()
    })

    it('каретка в самом списке — призрак есть', () => {
      setup(FILLED_CHOICE)
      activate(row('ch').getByLabelText('Вариант 1'))
      expect(row('ch').queryByLabelText('Добавить ответ')).toBeTruthy()
    })

    it('каретка на ЗАГОЛОВКЕ вопроса — призрак тоже есть', () => {
      // Активность считается по ГРУППЕ, а не по блоку: автор работает над вопросом
      // целиком, и список не имеет права схлопнуться у него под рукой.
      setup(FILLED_CHOICE)
      activate(row('cap').getByLabelText('Заголовок вопроса'))
      expect(row('ch').queryByLabelText('Добавить ответ')).toBeTruthy()
    })

    it('каретка ушла из вопроса — призрак исчез', () => {
      setup(FILLED_CHOICE)
      const opt = row('ch').getByLabelText('Вариант 1')
      activate(opt)
      fireEvent.focusOut(opt)
      expect(row('ch').queryByLabelText('Добавить ответ')).toBeNull()
    })

    it('у пустого списка призрак стоит всегда — иначе блок исчез бы с полотна', () => {
      setup(EMPTY_CHOICE)
      expect(row('ch').queryByLabelText('Добавить ответ')).toBeTruthy()
    })
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
