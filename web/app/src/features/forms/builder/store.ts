import { createStore, type StoreApi } from 'zustand/vanilla'

import {
  type Block,
  type BlockType,
  type FormSchema,
  type Option,
  SCHEMA_VERSION,
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

export type BuilderState = {
  blocks: Block[]
  // Текст кнопки отправки (форма-уровень). Пусто → рендерер берёт дефолт.
  submitLabel: string
  selectedId: string | null
  // dirty — есть несохранённые правки. Ставится любой мутацией документа, снимается
  // hydrate (загрузка с сервера) и markSaved (успешный автосейв). Выбор блока не
  // считается правкой и dirty не трогает.
  dirty: boolean
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
  return isChoiceType(type) ? { ...base, settings: { options: [] } } : base
}

// cloneBlock — глубокая копия, чтобы стор владел своими блоками и правка одного
// (в т.ч. массива options) не задевала исходник из Query или дубликат.
const cloneBlock = (b: Block): Block => structuredClone(b)

// mutateOptions применяет fn к опциям choice-блока и возвращает патч состояния.
// non-choice/несуществующий блок и «fn вернул тот же массив» (no-op на границе)
// дают пустой патч — состояние и dirty не меняются.
function mutateOptions(
  blocks: Block[],
  blockId: string,
  fn: (options: Option[]) => Option[],
): Partial<BuilderState> {
  const block = blocks.find((b) => b.id === blockId)
  if (!block || !isChoiceType(block.type)) return {}
  const options = block.settings?.options ?? []
  const next = fn(options)
  if (next === options) return {}
  return {
    blocks: blocks.map((b) =>
      b.id === blockId ? { ...b, settings: { ...b.settings, options: next } } : b,
    ),
    dirty: true,
  }
}

export function createBuilderStore(): StoreApi<BuilderStore> {
  return createStore<BuilderStore>((set, get) => ({
    blocks: [],
    submitLabel: '',
    selectedId: null,
    dirty: false,

    hydrate: (schema) =>
      set({
        blocks: schema.blocks.map(cloneBlock),
        submitLabel: schema.submitLabel ?? '',
        selectedId: null,
        dirty: false,
      }),

    addBlock: (type) => {
      const block = newBlock(type)
      set((s) => ({ blocks: [...s.blocks, block], selectedId: block.id, dirty: true }))
    },

    addBlockAfter: (afterId, type) => {
      const block = newBlock(type)
      set((s) => {
        const i = afterId ? s.blocks.findIndex((b) => b.id === afterId) : -1
        const at = i >= 0 ? i + 1 : s.blocks.length
        const blocks = s.blocks.slice()
        blocks.splice(at, 0, block)
        return { blocks, selectedId: block.id, dirty: true }
      })
      return block.id
    },

    changeBlockType: (id, type) => {
      set((s) => {
        const src = s.blocks.find((b) => b.id === id)
        if (!src) return s
        // newBlock даёт корректные дефолтные settings под тип (choice → пустой
        // список опций, non-choice → пустые); переносим текст и обязательность.
        const converted: Block = {
          ...newBlock(type),
          id,
          label: src.label,
          description: src.description,
          required: src.required,
        }
        return { blocks: s.blocks.map((b) => (b.id === id ? converted : b)), selectedId: id, dirty: true }
      })
      return id
    },

    updateBlock: (id, patch) =>
      set((s) => ({
        blocks: s.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
        dirty: true,
      })),

    removeBlock: (id) =>
      set((s) => ({
        blocks: s.blocks.filter((b) => b.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
        dirty: true,
      })),

    moveBlock: (id, dir) =>
      set((s) => {
        const i = s.blocks.findIndex((b) => b.id === id)
        const j = dir === 'up' ? i - 1 : i + 1
        const a = s.blocks[i]
        const b = s.blocks[j]
        if (!a || !b) return s // блок не найден или уже на границе — ничего не меняем
        const blocks = s.blocks.slice()
        blocks[i] = b
        blocks[j] = a
        return { blocks, dirty: true }
      }),

    reorderBlocks: (activeId, overId) =>
      set((s) => {
        const from = s.blocks.findIndex((b) => b.id === activeId)
        const to = s.blocks.findIndex((b) => b.id === overId)
        if (from < 0 || to < 0 || from === to) return s
        const blocks = s.blocks.slice()
        const [moved] = blocks.splice(from, 1)
        if (!moved) return s
        blocks.splice(to, 0, moved)
        return { blocks, dirty: true }
      }),

    duplicateBlock: (id) =>
      set((s) => {
        const i = s.blocks.findIndex((b) => b.id === id)
        const src = s.blocks[i]
        if (!src) return s
        const copy: Block = { ...cloneBlock(src), id: newBlockId() }
        const blocks = s.blocks.slice()
        blocks.splice(i + 1, 0, copy)
        return { blocks, selectedId: copy.id, dirty: true }
      }),

    addOption: (blockId) =>
      set((s) =>
        mutateOptions(s.blocks, blockId, (opts) => [...opts, { id: newOptionId(), label: '' }]),
      ),

    updateOption: (blockId, optionId, label) =>
      set((s) =>
        mutateOptions(s.blocks, blockId, (opts) =>
          opts.map((o) => (o.id === optionId ? { ...o, label } : o)),
        ),
      ),

    removeOption: (blockId, optionId) =>
      set((s) =>
        mutateOptions(s.blocks, blockId, (opts) => opts.filter((o) => o.id !== optionId)),
      ),

    moveOption: (blockId, optionId, dir) =>
      set((s) =>
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

    setSubmitLabel: (label) => set({ submitLabel: label, dirty: true }),

    markSaved: () => set({ dirty: false }),

    toSchema: () => ({
      schemaVersion: SCHEMA_VERSION,
      blocks: get().blocks,
      submitLabel: get().submitLabel,
    }),
  }))
}
