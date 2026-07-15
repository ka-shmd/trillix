import { describe, expect, it } from 'vitest'

import { formSchemaSchema, type FormSchema } from '@entities/formSchema'

import { createBuilderStore } from './store'

// Стор билдера — чистый TS, гоняем напрямую через getState(), без React.

describe('createBuilderStore', () => {
  it('стартует пустым и не dirty', () => {
    const s = createBuilderStore().getState()
    expect(s.blocks).toEqual([])
    expect(s.selectedId).toBeNull()
    expect(s.dirty).toBe(false)
  })

  it('addBlock добавляет в конец, выделяет новый и помечает dirty', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('email')

    const s = store.getState()
    expect(s.blocks.map((b) => b.type)).toEqual(['short_text', 'email'])
    expect(s.selectedId).toBe(s.blocks[1]?.id)
    expect(s.dirty).toBe(true)
    // id уникальны.
    expect(s.blocks[0]?.id).not.toBe(s.blocks[1]?.id)
  })

  it('choice-блок стартует с пустым списком опций, non-choice — без опций', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    store.getState().addBlock('number')

    const [choice, number] = store.getState().blocks
    expect(choice?.settings?.options).toEqual([])
    expect(number?.settings?.options).toBeUndefined()
  })

  it('updateBlock патчит только целевой блок', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('short_text')
    const [first, second] = store.getState().blocks
    store.getState().markSaved()

    store.getState().updateBlock(first!.id, { label: 'Имя', required: true })

    const s = store.getState()
    expect(s.blocks[0]?.label).toBe('Имя')
    expect(s.blocks[0]?.required).toBe(true)
    expect(s.blocks[1]?.id).toBe(second!.id)
    expect(s.blocks[1]?.label).toBe('')
    expect(s.dirty).toBe(true)
  })

  it('removeBlock удаляет блок и снимает выделение, если удалили выделенный', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const id = store.getState().blocks[0]!.id

    store.getState().removeBlock(id)

    const s = store.getState()
    expect(s.blocks).toHaveLength(0)
    expect(s.selectedId).toBeNull()
  })

  it('moveBlock двигает блок и no-op на границе', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text') // a
    store.getState().addBlock('email') // b
    store.getState().addBlock('number') // c
    const [a, b, c] = store.getState().blocks.map((x) => x.id)

    store.getState().moveBlock(b!, 'up')
    expect(store.getState().blocks.map((x) => x.id)).toEqual([b, a, c])

    // Верхний вверх — граница, ничего не меняется и dirty не поднимается.
    store.getState().markSaved()
    store.getState().moveBlock(b!, 'up')
    expect(store.getState().blocks.map((x) => x.id)).toEqual([b, a, c])
    expect(store.getState().dirty).toBe(false)
  })

  it('addBlockAfter вставляет после указанного блока и возвращает id', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text') // a
    store.getState().addBlock('number') // c
    const [a, c] = store.getState().blocks.map((x) => x.id)
    store.getState().markSaved()

    const newId = store.getState().addBlockAfter(a!, 'email')

    const s = store.getState()
    expect(s.blocks.map((x) => x.id)).toEqual([a, newId, c])
    expect(s.blocks[1]?.type).toBe('email')
    expect(s.selectedId).toBe(newId)
    expect(s.dirty).toBe(true)
  })

  it('addBlockAfter с null добавляет в конец', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const a = store.getState().blocks[0]!.id

    const newId = store.getState().addBlockAfter(null, 'date')

    expect(store.getState().blocks.map((x) => x.id)).toEqual([a, newId])
  })

  it('changeBlockType меняет тип на месте, сохраняя id/label/required и сбрасывая опции', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    const id = store.getState().blocks[0]!.id
    store.getState().updateBlock(id, { label: 'Выбор', required: true })
    store.getState().addOption(id)
    store.getState().markSaved()

    const returned = store.getState().changeBlockType(id, 'short_text')

    const b = store.getState().blocks[0]!
    expect(returned).toBe(id)
    expect(b.id).toBe(id) // id стабилен
    expect(b.type).toBe('short_text')
    expect(b.label).toBe('Выбор') // текст сохранён
    expect(b.required).toBe(true)
    expect(b.settings?.options).toBeUndefined() // тип-специфика сброшена
    expect(store.getState().dirty).toBe(true)
  })

  it('changeBlockType на несуществующем блоке — no-op', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().markSaved()

    store.getState().changeBlockType('нет-такого', 'email')

    expect(store.getState().blocks[0]?.type).toBe('short_text')
    expect(store.getState().dirty).toBe(false)
  })

  it('reorderBlocks переносит блок на позицию другого (dnd)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text') // a
    store.getState().addBlock('email') // b
    store.getState().addBlock('number') // c
    const [a, b, c] = store.getState().blocks.map((x) => x.id)

    // Перетащили a на место c → порядок b, c, a.
    store.getState().reorderBlocks(a!, c!)
    expect(store.getState().blocks.map((x) => x.id)).toEqual([b, c, a])
    expect(store.getState().dirty).toBe(true)

    // Та же позиция / неизвестный id — no-op, dirty не поднимается.
    store.getState().markSaved()
    store.getState().reorderBlocks(b!, b!)
    store.getState().reorderBlocks('нет', c!)
    expect(store.getState().blocks.map((x) => x.id)).toEqual([b, c, a])
    expect(store.getState().dirty).toBe(false)
  })

  it('duplicateBlock вставляет глубокую копию сразу за оригиналом с новым id', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    const orig = store.getState().blocks[0]!
    store.getState().updateBlock(orig.id, { settings: { options: [{ id: 'o1', label: 'A' }] } })

    store.getState().duplicateBlock(orig.id)

    const s = store.getState()
    expect(s.blocks).toHaveLength(2)
    const copy = s.blocks[1]!
    expect(copy.id).not.toBe(orig.id)
    expect(copy.type).toBe('single_choice')
    expect(s.selectedId).toBe(copy.id)

    // Глубокая копия: правка опций дубликата не задевает оригинал.
    store.getState().updateBlock(copy.id, { settings: { options: [{ id: 'o1', label: 'Z' }] } })
    expect(store.getState().blocks[0]?.settings?.options?.[0]?.label).toBe('A')
  })

  it('addOption добавляет пустой вариант choice-блоку', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    const id = store.getState().blocks[0]!.id
    store.getState().markSaved()

    store.getState().addOption(id)

    const opts = store.getState().blocks[0]?.settings?.options
    expect(opts).toHaveLength(1)
    expect(opts?.[0]?.label).toBe('')
    expect(store.getState().dirty).toBe(true)
  })

  it('addOption на non-choice — no-op, dirty не поднимается', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const id = store.getState().blocks[0]!.id
    store.getState().markSaved()

    store.getState().addOption(id)

    expect(store.getState().blocks[0]?.settings?.options).toBeUndefined()
    expect(store.getState().dirty).toBe(false)
  })

  it('updateOption/removeOption правят конкретный вариант', () => {
    const store = createBuilderStore()
    store.getState().addBlock('multi_choice')
    const id = store.getState().blocks[0]!.id
    store.getState().addOption(id)
    store.getState().addOption(id)
    const [o1, o2] = store.getState().blocks[0]!.settings!.options!.map((o) => o.id)

    store.getState().updateOption(id, o1!, 'Go')
    expect(store.getState().blocks[0]?.settings?.options?.[0]?.label).toBe('Go')

    store.getState().removeOption(id, o2!)
    const opts = store.getState().blocks[0]!.settings!.options!
    expect(opts).toHaveLength(1)
    expect(opts[0]?.id).toBe(o1)
  })

  it('moveOption меняет порядок и no-op на границе', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    const id = store.getState().blocks[0]!.id
    store.getState().addOption(id)
    store.getState().addOption(id)
    const [a, b] = store.getState().blocks[0]!.settings!.options!.map((o) => o.id)

    store.getState().moveOption(id, b!, 'up')
    expect(store.getState().blocks[0]!.settings!.options!.map((o) => o.id)).toEqual([b, a])

    store.getState().markSaved()
    store.getState().moveOption(id, b!, 'up') // уже сверху — граница
    expect(store.getState().blocks[0]!.settings!.options!.map((o) => o.id)).toEqual([b, a])
    expect(store.getState().dirty).toBe(false)
  })

  it('hydrate загружает схему и сбрасывает dirty/selection', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text') // делает dirty + выделение
    const schema: FormSchema = {
      schemaVersion: 1,
      blocks: [{ id: 'x', type: 'email', label: 'Почта' }],
    }

    store.getState().hydrate(schema)

    const s = store.getState()
    expect(s.blocks).toEqual(schema.blocks)
    expect(s.dirty).toBe(false)
    expect(s.selectedId).toBeNull()
    // Копия, а не та же ссылка (стор владеет своими блоками).
    expect(s.blocks[0]).not.toBe(schema.blocks[0])
  })

  it('setSubmitLabel меняет текст кнопки и помечает dirty; toSchema его несёт', () => {
    const store = createBuilderStore()
    expect(store.getState().submitLabel).toBe('')

    store.getState().setSubmitLabel('Готово')
    expect(store.getState().submitLabel).toBe('Готово')
    expect(store.getState().dirty).toBe(true)
    expect(store.getState().toSchema().submitLabel).toBe('Готово')
  })

  it('hydrate загружает submitLabel из схемы', () => {
    const store = createBuilderStore()
    store.getState().hydrate({ schemaVersion: 1, blocks: [], submitLabel: 'Отправить ответ' })
    expect(store.getState().submitLabel).toBe('Отправить ответ')
  })

  it('markSaved снимает dirty', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    expect(store.getState().dirty).toBe(true)
    store.getState().markSaved()
    expect(store.getState().dirty).toBe(false)
  })

  it('toSchema отдаёт валидный по контракту документ', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('single_choice')
    store.getState().updateBlock(store.getState().blocks[0]!.id, { label: 'Имя' })

    const schema = store.getState().toSchema()
    expect(schema.schemaVersion).toBe(1)
    expect(schema.blocks).toHaveLength(2)
    // Выход стора обязан проходить ту же Zod-проверку, что и на сервере.
    expect(formSchemaSchema.safeParse(schema).success).toBe(true)
  })
})

describe('createBuilderStore — undo/redo', () => {
  it('undo откатывает последнюю структурную правку, redo возвращает', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('email')
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['short_text', 'email'])

    store.getState().undo()
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['short_text'])

    store.getState().redo()
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['short_text', 'email'])
  })

  it('undo/redo восстанавливают submitLabel и ставят dirty', () => {
    const store = createBuilderStore()
    store.getState().setSubmitLabel('Готово')
    store.getState().markSaved()
    expect(store.getState().dirty).toBe(false)

    store.getState().undo()
    expect(store.getState().submitLabel).toBe('')
    expect(store.getState().dirty).toBe(true)

    store.getState().redo()
    expect(store.getState().submitLabel).toBe('Готово')
    expect(store.getState().dirty).toBe(true)
  })

  it('undo/redo на пустом стеке — no-op', () => {
    const store = createBuilderStore()
    store.getState().undo()
    store.getState().redo()
    expect(store.getState().blocks).toEqual([])
    // Пустая история не наплодила снапшотов и не поставила dirty.
    expect(store.getState().dirty).toBe(false)
    expect(store.getState().past).toEqual([])
    expect(store.getState().future).toEqual([])
  })

  it('новая правка после undo обрывает ветку redo', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('email')
    store.getState().undo() // future = [email-состояние]
    expect(store.getState().future).toHaveLength(1)

    store.getState().addBlock('number') // новая ветка чистит future
    expect(store.getState().future).toEqual([])
    store.getState().redo() // нечего повторять — no-op
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['short_text', 'number'])
  })

  it('граничный no-op (moveBlock на краю) не пишет историю', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const before = store.getState().past.length
    store.getState().moveBlock(store.getState().blocks[0]!.id, 'up') // уже первый
    expect(store.getState().past.length).toBe(before)
  })

  it('непрерывный ввод текста коалесится в один шаг отмены', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const id = store.getState().blocks[0]!.id
    store.getState().updateBlock(id, { label: 'И' })
    store.getState().updateBlock(id, { label: 'Им' })
    store.getState().updateBlock(id, { label: 'Имя' })

    // Один undo убирает весь набранный текст, а не по символу.
    store.getState().undo()
    expect(store.getState().blocks[0]!.label).toBe('')
    // Второй undo убирает уже сам блок.
    store.getState().undo()
    expect(store.getState().blocks).toEqual([])
  })

  it('правки разных полей и дискретный required — отдельные шаги', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const id = store.getState().blocks[0]!.id
    store.getState().updateBlock(id, { label: 'Вопрос' })
    store.getState().updateBlock(id, { required: true }) // дискретно — свой шаг
    store.getState().updateBlock(id, { description: 'Пояснение' })

    store.getState().undo() // снимает description
    expect(store.getState().blocks[0]!.description).toBe('')
    expect(store.getState().blocks[0]!.required).toBe(true)
    store.getState().undo() // снимает required
    expect(store.getState().blocks[0]!.required).toBe(false)
    expect(store.getState().blocks[0]!.label).toBe('Вопрос')
  })

  it('hydrate очищает историю', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().hydrate({ schemaVersion: 1, blocks: [], submitLabel: '' })
    expect(store.getState().past).toEqual([])
    store.getState().undo() // нечего откатывать
    expect(store.getState().blocks).toEqual([])
  })

  it('undo снимает выделение, если выделенный блок исчез', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text') // selectedId = этот блок
    const id = store.getState().blocks[0]!.id
    expect(store.getState().selectedId).toBe(id)

    store.getState().undo() // блок исчез — выделять нечего
    expect(store.getState().blocks).toEqual([])
    expect(store.getState().selectedId).toBeNull()
  })
})
