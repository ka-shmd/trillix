import { createStore, type StoreApi } from 'zustand/vanilla'

import {
  type Block,
  type BlockType,
  type FormSchema,
  type Option,
  SCHEMA_VERSION,
  DEFAULT_SCALE_MAX,
  DEFAULT_SCALE_MIN,
  isChoiceType,
} from '@entities/formSchema'

// Стор билдера — высокочастотный локальный документ формы (ARCHITECTURE §5.1):
// каждая правка label — синхронная операция над стором, мгновенный UI, а
// дебаунс-автосейв (шаг 6) шлёт весь draft_schema. Здесь только сам документ и
// операции над ним; React-обвязки нет — стор чистый и тестируется vitest напрямую.
//
// Фабрика (а не модульный синглтон): билдер открывает конкретную форму, при
// смене formId нужен свежий стор — контекст-провайдер (шаг 4) создаёт по одному
// на инстанс, а тесты — по одному на кейс.

// Стабильные client-side id блока/опции. Префикс — для читаемости JSON;
// уникальность держится на случайности UUID. Сервер (ValidateSchema) — финальная
// проверка непустоты/длины/уникальности.
const newBlockId = (): string => `blk_${crypto.randomUUID()}`
const newOptionId = (): string => `opt_${crypto.randomUUID()}`

// Редактируемые поля блока. id и type через updateBlock не меняются: id стабилен
// (на него ссылаются ответы), смена типа — это другой блок, не правка этого.
export type BlockPatch = Partial<Pick<Block, 'label' | 'description' | 'required' | 'settings'>>

// Snapshot — снимок документа (blocks + поля формы-уровня) для стеков undo/redo.
// selectedId и dirty — производный UI, в снапшот не входят; при откате selectedId
// чинится, если выделенный блок исчез. Новое поле документа обязано попасть сюда,
// иначе undo его молча потеряет.
export type Snapshot = {
  blocks: Block[]
  submitLabel: string
  thankYouText: string
  redirectUrl: string
}

// Потолок глубины истории: длинная сессия не должна расти в памяти без предела.
const MAX_HISTORY = 100

export type BuilderState = {
  blocks: Block[]
  // Текст кнопки отправки (форма-уровень). Пусто → рендерер берёт дефолт.
  submitLabel: string
  // Экран «после отправки» (форма-уровень). thankYouText пусто → рендерер берёт
  // дефолтную благодарность; redirectUrl пусто → перехода нет.
  thankYouText: string
  redirectUrl: string
  selectedId: string | null
  // dirty — есть несохранённые правки. Ставится любой мутацией документа, снимается
  // hydrate (загрузка с сервера) и markSaved (успешный автосейв). Выбор блока не
  // считается правкой и dirty не трогает.
  dirty: boolean
  // past/future — стеки снапшотов для undo/redo. past хранит состояния ДО каждого
  // изменения (вершина — последнее); future наполняется при undo. Любое новое
  // изменение чистит future (ветка redo обрывается).
  past: Snapshot[]
  future: Snapshot[]
  // lastTag коалесит непрерывный ввод: соседние правки с одинаковым ненулевым тегом
  // (набор в одно поле) делят один шаг истории. Структурные операции — тег null,
  // всегда свой шаг. Сбрасывается undo/redo, чтобы после отмены новый ввод не
  // прилипал к докатанному снапшоту.
  lastTag: string | null
}

export type BuilderActions = {
  // hydrate загружает форму, пришедшую через Query, в стор (чистое состояние).
  hydrate: (schema: FormSchema) => void
  addBlock: (type: BlockType) => void
  // addBlockAfter вставляет блок сразу после afterId (или в конец при null) и
  // возвращает его id — slash-редактору нужен id, чтобы поставить фокус на новую
  // строку (Enter создаёт следующий блок под текущим, а не в конце списка).
  addBlockAfter: (afterId: string | null, type: BlockType) => string
  // changeBlockType меняет тип блока на месте (id стабилен), сохраняя label/
  // description/required и сбрасывая тип-специфичные settings. Это конверсия типа
  // slash-командой («/» → выбор типа) — ощущается как правка того же блока, как в
  // Notion. Возвращает id для фокуса. На несуществующем блоке — no-op.
  changeBlockType: (id: string, type: BlockType) => string
  updateBlock: (id: string, patch: BlockPatch) => void
  removeBlock: (id: string) => void
  // moveBlock двигает блок на одну позицию; на границе списка — no-op (dirty не трогает).
  moveBlock: (id: string, dir: 'up' | 'down') => void
  // reorderBlocks переносит activeId на позицию overId (drag-and-drop, dnd-kit).
  // Неизвестный id или та же позиция — no-op (dirty не трогает).
  reorderBlocks: (activeId: string, overId: string) => void
  duplicateBlock: (id: string) => void
  // Редактор опций choice-блока. На non-choice и несуществующем блоке — no-op.
  addOption: (blockId: string) => void
  updateOption: (blockId: string, optionId: string, label: string) => void
  removeOption: (blockId: string, optionId: string) => void
  moveOption: (blockId: string, optionId: string, dir: 'up' | 'down') => void
  select: (id: string | null) => void
  // setSubmitLabel меняет текст кнопки отправки (форма-уровень).
  setSubmitLabel: (label: string) => void
  // setAfterSubmit применяет настройки экрана «после отправки» целиком. Одним
  // действием, а не полем за полем: страница настроек сохраняется по кнопке, и
  // нажатие обязано быть одним шагом отмены. Никаких правок — no-op (историю и
  // dirty не трогает).
  setAfterSubmit: (settings: { thankYouText: string; redirectUrl: string }) => void
  // undo/redo откатывают и повторяют изменения документа. Пустой стек — no-op.
  undo: () => void
  redo: () => void
  // markSaved снимает dirty после успешного PATCH (автосейв — шаг 6).
  markSaved: () => void
  // toSchema сериализует документ для отправки на бэкенд.
  toSchema: () => FormSchema
}

export type BuilderStore = BuilderState & BuilderActions

// newBlock создаёт валидный черновой блок: пустой label, дефолты. Choice-тип
// стартует с пустым списком опций — допустимое недособранное состояние (редактор
// опций — шаг 5); non-choice остаётся с пустыми settings (иначе ValidateSchema
// отвергнет опции у не-choice).
export function newBlock(type: BlockType): Block {
  const base: Block = {
    id: newBlockId(),
    type,
    label: '',
    description: '',
    required: false,
    settings: {},
  }
  if (isChoiceType(type)) return { ...base, settings: { options: [] } }
  // Шкала создаётся с диапазоном: схема без него валидна (недособранный черновик),
  // но респонденту нужен готовый ряд делений, а не пустота.
  if (type === 'scale') {
    return { ...base, settings: { scaleMin: DEFAULT_SCALE_MIN, scaleMax: DEFAULT_SCALE_MAX } }
  }
  return base
}

// cloneBlock — глубокая копия, чтобы стор владел своими блоками и правка одного
// (в т.ч. массива options) не задевала исходник из Query или дубликат.
const cloneBlock = (b: Block): Block => structuredClone(b)

// mutateOptions применяет fn к опциям choice-блока и возвращает патч блоков или
// null. non-choice/несуществующий блок и «fn вернул тот же массив» (no-op на
// границе) дают null — commit не тронет ни состояние, ни историю.
function mutateOptions(
  blocks: Block[],
  blockId: string,
  fn: (options: Option[]) => Option[],
): Pick<BuilderState, 'blocks'> | null {
  const block = blocks.find((b) => b.id === blockId)
  if (!block || !isChoiceType(block.type)) return null
  const options = block.settings?.options ?? []
  const next = fn(options)
  if (next === options) return null
  return {
    blocks: blocks.map((b) =>
      b.id === blockId ? { ...b, settings: { ...b.settings, options: next } } : b,
    ),
  }
}

// snapshot снимает документ (blocks + поля формы-уровня) для стеков истории.
const snapshot = (s: BuilderState): Snapshot => ({
  blocks: s.blocks,
  submitLabel: s.submitLabel,
  thankYouText: s.thankYouText,
  redirectUrl: s.redirectUrl,
})

// fixSelection чинит выделение после отката: если выделенный блок в новом наборе
// исчез, снимаем выделение.
const fixSelection = (selectedId: string | null, blocks: Block[]): string | null =>
  selectedId && blocks.some((b) => b.id === selectedId) ? selectedId : null

// textTag коалесит непрерывный ввод через updateBlock: правки текстовых полей
// (label/description/settings-placeholder) в один блок делят шаг истории; патч с
// required (или иным дискретным полем) — свой шаг (тег null).
function updateBlockTag(id: string, patch: BlockPatch): string | null {
  const keys = Object.keys(patch)
  const textOnly =
    keys.length > 0 && keys.every((k) => k === 'label' || k === 'description' || k === 'settings')
  return textOnly ? `ub:${id}:${keys.sort().join('+')}` : null
}

export function createBuilderStore(): StoreApi<BuilderStore> {
  return createStore<BuilderStore>((set, get) => {
    // commit — единственный путь мутации документа: применяет патч от producer и
    // записывает историю. producer возвращает null для no-op (граница move, чужой
    // блок) — тогда ни состояние, ни история не трогаются. tag коалесит соседние
    // правки: одинаковый ненулевой тег продолжает текущий шаг (снапшот в past уже
    // лежит), иначе кладётся новый снапшот. Любая мутация чистит future и ставит
    // dirty.
    function commit(
      tag: string | null,
      producer: (s: BuilderStore) => Partial<BuilderState> | null,
    ): void {
      set((s) => {
        const patch = producer(s)
        if (patch === null) return s
        const coalesce = tag !== null && tag === s.lastTag
        const past = coalesce ? s.past : [...s.past, snapshot(s)].slice(-MAX_HISTORY)
        return { ...patch, past, future: [], lastTag: tag, dirty: true }
      })
    }

    return {
      blocks: [],
      submitLabel: '',
      thankYouText: '',
      redirectUrl: '',
      selectedId: null,
      dirty: false,
      past: [],
      future: [],
      lastTag: null,

      hydrate: (schema) =>
        set({
          blocks: schema.blocks.map(cloneBlock),
          submitLabel: schema.submitLabel ?? '',
          thankYouText: schema.thankYouText ?? '',
          redirectUrl: schema.redirectUrl ?? '',
          selectedId: null,
          dirty: false,
          past: [],
          future: [],
          lastTag: null,
        }),

      addBlock: (type) => {
        const block = newBlock(type)
        commit(null, (s) => ({ blocks: [...s.blocks, block], selectedId: block.id }))
      },

      addBlockAfter: (afterId, type) => {
        const block = newBlock(type)
        commit(null, (s) => {
          const i = afterId ? s.blocks.findIndex((b) => b.id === afterId) : -1
          const at = i >= 0 ? i + 1 : s.blocks.length
          const blocks = s.blocks.slice()
          blocks.splice(at, 0, block)
          return { blocks, selectedId: block.id }
        })
        return block.id
      },

      changeBlockType: (id, type) => {
        commit(null, (s) => {
          const src = s.blocks.find((b) => b.id === id)
          if (!src) return null
          // newBlock даёт корректные дефолтные settings под тип (choice → пустой
          // список опций, non-choice → пустые); переносим текст и обязательность.
          const converted: Block = {
            ...newBlock(type),
            id,
            label: src.label,
            description: src.description,
            required: src.required,
          }
          return { blocks: s.blocks.map((b) => (b.id === id ? converted : b)), selectedId: id }
        })
        return id
      },

      updateBlock: (id, patch) =>
        commit(updateBlockTag(id, patch), (s) => ({
          blocks: s.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
        })),

      removeBlock: (id) =>
        commit(null, (s) => ({
          blocks: s.blocks.filter((b) => b.id !== id),
          selectedId: s.selectedId === id ? null : s.selectedId,
        })),

      moveBlock: (id, dir) =>
        commit(null, (s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          const j = dir === 'up' ? i - 1 : i + 1
          const a = s.blocks[i]
          const b = s.blocks[j]
          if (!a || !b) return null // блок не найден или уже на границе — ничего не меняем
          const blocks = s.blocks.slice()
          blocks[i] = b
          blocks[j] = a
          return { blocks }
        }),

      reorderBlocks: (activeId, overId) =>
        commit(null, (s) => {
          const from = s.blocks.findIndex((b) => b.id === activeId)
          const to = s.blocks.findIndex((b) => b.id === overId)
          if (from < 0 || to < 0 || from === to) return null
          const blocks = s.blocks.slice()
          const [moved] = blocks.splice(from, 1)
          if (!moved) return null
          blocks.splice(to, 0, moved)
          return { blocks }
        }),

      duplicateBlock: (id) =>
        commit(null, (s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          const src = s.blocks[i]
          if (!src) return null
          const copy: Block = { ...cloneBlock(src), id: newBlockId() }
          const blocks = s.blocks.slice()
          blocks.splice(i + 1, 0, copy)
          return { blocks, selectedId: copy.id }
        }),

      addOption: (blockId) =>
        commit(null, (s) =>
          mutateOptions(s.blocks, blockId, (opts) => [
            ...opts,
            { id: newOptionId(), label: '' },
          ]),
        ),

      updateOption: (blockId, optionId, label) =>
        commit(`uo:${blockId}:${optionId}`, (s) =>
          mutateOptions(s.blocks, blockId, (opts) =>
            opts.map((o) => (o.id === optionId ? { ...o, label } : o)),
          ),
        ),

      removeOption: (blockId, optionId) =>
        commit(null, (s) =>
          mutateOptions(s.blocks, blockId, (opts) => opts.filter((o) => o.id !== optionId)),
        ),

      moveOption: (blockId, optionId, dir) =>
        commit(null, (s) =>
          mutateOptions(s.blocks, blockId, (opts) => {
            const i = opts.findIndex((o) => o.id === optionId)
            const j = dir === 'up' ? i - 1 : i + 1
            const a = opts[i]
            const b = opts[j]
            if (!a || !b) return opts // не найдено или граница — тот же массив (no-op)
            const next = opts.slice()
            next[i] = b
            next[j] = a
            return next
          }),
        ),

      select: (id) => set({ selectedId: id }),

      setSubmitLabel: (label) => commit('sl', () => ({ submitLabel: label })),

      // Тег null: настройки прилетают готовым набором по кнопке, коалесить нечего.
      setAfterSubmit: ({ thankYouText, redirectUrl }) =>
        commit(null, (s) =>
          s.thankYouText === thankYouText && s.redirectUrl === redirectUrl
            ? null
            : { thankYouText, redirectUrl },
        ),

      undo: () =>
        set((s) => {
          const prev = s.past[s.past.length - 1]
          if (!prev) return s
          // Снапшот разворачивается целиком, а не по полю: перечисление руками —
          // это ровно тот способ, которым новое поле документа теряется в undo.
          return {
            ...prev,
            selectedId: fixSelection(s.selectedId, prev.blocks),
            past: s.past.slice(0, -1),
            future: [...s.future, snapshot(s)],
            lastTag: null,
            dirty: true,
          }
        }),

      redo: () =>
        set((s) => {
          const next = s.future[s.future.length - 1]
          if (!next) return s
          return {
            ...next,
            selectedId: fixSelection(s.selectedId, next.blocks),
            past: [...s.past, snapshot(s)],
            future: s.future.slice(0, -1),
            lastTag: null,
            dirty: true,
          }
        }),

      markSaved: () => set({ dirty: false }),

      toSchema: () => ({
        schemaVersion: SCHEMA_VERSION,
        blocks: get().blocks,
        submitLabel: get().submitLabel,
        thankYouText: get().thankYouText,
        redirectUrl: get().redirectUrl,
      }),
    }
  })
}
