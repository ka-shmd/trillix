import { describe, expect, it } from 'vitest'

import { formSchemaSchema, type FormSchema } from '@entities/formSchema'

import { createBuilderStore } from './store'

// Стор билдера — чистый TS, гоняем напрямую через getState(), без React. Модель v2
// (фаза 8.7): вопрос — группа блоков, groupId выводит regroup из раскладки.

describe('createBuilderStore', () => {
  it('стартует пустым и не dirty', () => {
    const s = createBuilderStore().getState()
    expect(s.blocks).toEqual([])
    expect(s.dirty).toBe(false)
  })

  it('addBlock добавляет в конец и помечает dirty', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('email')

    const s = store.getState()
    expect(s.blocks.map((b) => b.type)).toEqual(['short_text', 'email'])
    expect(s.dirty).toBe(true)
    expect(s.blocks[0]?.id).not.toBe(s.blocks[1]?.id)
  })

  it('regroup: подпись и поле подряд делят groupId, два поля — разные группы', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    store.getState().addBlock('short_text')
    store.getState().addBlock('email')
    const [title, field, email] = store.getState().blocks

    // title + short_text — одна группа (title накапливается, поле закрывает).
    expect(title?.groupId).toBe(field?.groupId)
    // Следующее поле — своя группа (≤1 отвечаемого в группе).
    expect(email?.groupId).not.toBe(field?.groupId)
  })

  it('choice-блок стартует с пустым списком опций, non-choice — без опций', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    store.getState().addBlock('number')

    const [choice, number] = store.getState().blocks
    expect(choice?.settings?.options).toEqual([])
    expect(number?.settings?.options).toBeUndefined()
  })

  it('updateBlock патчит только целевой блок (text у подписи)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    store.getState().addBlock('title')
    const [first, second] = store.getState().blocks
    store.getState().markSaved()

    store.getState().updateBlock(first!.id, { text: 'Имя' })

    const s = store.getState()
    expect(s.blocks[0]?.text).toBe('Имя')
    expect(s.blocks[1]?.id).toBe(second!.id)
    expect(s.blocks[1]?.text).toBe('')
    expect(s.dirty).toBe(true)
  })

  it('removeBlock удаляет блок и помечает dirty', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const id = store.getState().blocks[0]!.id
    store.getState().markSaved()

    store.getState().removeBlock(id)

    const s = store.getState()
    expect(s.blocks).toHaveLength(0)
    expect(s.dirty).toBe(true)
  })

  it('moveBlock двигает блок и no-op на границе', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('email')
    store.getState().addBlock('number')
    const [a, b, c] = store.getState().blocks.map((x) => x.id)

    store.getState().moveBlock(b!, 'up')
    expect(store.getState().blocks.map((x) => x.id)).toEqual([b, a, c])

    store.getState().markSaved()
    store.getState().moveBlock(b!, 'up')
    expect(store.getState().blocks.map((x) => x.id)).toEqual([b, a, c])
    expect(store.getState().dirty).toBe(false)
  })

  it('addBlockAfter вставляет после указанного блока и возвращает id', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('number')
    const [a, c] = store.getState().blocks.map((x) => x.id)
    store.getState().markSaved()

    const newId = store.getState().addBlockAfter(a!, 'email')

    const s = store.getState()
    expect(s.blocks.map((x) => x.id)).toEqual([a, newId, c])
    expect(s.blocks[1]?.type).toBe('email')
    expect(s.dirty).toBe(true)
  })

  it('addBlockAfter с null добавляет в конец', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const a = store.getState().blocks[0]!.id

    const newId = store.getState().addBlockAfter(null, 'date')

    expect(store.getState().blocks.map((x) => x.id)).toEqual([a, newId])
  })

  it('makeQuestion: блок с текстом → подпись + поле в одной группе (раздел «Вопросы»)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text') // абзац как черновая строка
    const id = store.getState().blocks[0]!.id
    store.getState().updateBlock(id, { text: 'Ваше имя' })
    store.getState().markSaved()

    const focus = store.getState().makeQuestion(id, 'short_text')

    const s = store.getState()
    expect(s.blocks).toHaveLength(2)
    // Набранный текст стал подписью (id сохранён), под ней — поле.
    expect(s.blocks[0]?.id).toBe(id)
    expect(s.blocks[0]?.type).toBe('title')
    expect(s.blocks[0]?.text).toBe('Ваше имя')
    expect(s.blocks[1]?.type).toBe('short_text')
    expect(s.blocks[1]?.text).toBe('')
    // Одна группа на подпись и поле; фокус — на подпись (у неё textarea).
    expect(s.blocks[0]?.groupId).toBe(s.blocks[1]?.groupId)
    expect(focus).toBe(id)
  })

  it('addQuestionAfter вставляет бандл (пустая подпись + поле) и фокусит подпись', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const a = store.getState().blocks[0]!.id

    const focus = store.getState().addQuestionAfter(a, 'email')

    const s = store.getState()
    expect(s.blocks).toHaveLength(3) // поле a + [title, email]
    expect(s.blocks[1]?.type).toBe('title')
    expect(s.blocks[1]?.text).toBe('')
    expect(s.blocks[2]?.type).toBe('email')
    expect(s.blocks[1]?.groupId).toBe(s.blocks[2]?.groupId)
    expect(focus).toBe(s.blocks[1]?.id)
  })

  it('makeQuestion внутри группы → новый вопрос НИЖЕ группы (инпут не встраивается)', () => {
    const store = createBuilderStore()
    // Группа: [title, text(контент), short_text]
    store.getState().addQuestionAfter(null, 'short_text')
    const titleId = store.getState().blocks[0]!.id
    store.getState().addBlockAfter(titleId, 'text') // лэйаут-контент в группу
    const s0 = store.getState().blocks
    expect(s0.map((b) => b.type)).toEqual(['title', 'text', 'short_text'])
    const gid = s0[0]!.groupId
    expect(s0.every((b) => b.groupId === gid)).toBe(true)

    // «/» на контентном блоке → бандл email: новая группа НИЖЕ, исходная цела.
    const contentId = store.getState().blocks[1]!.id
    store.getState().makeQuestion(contentId, 'email')

    const s = store.getState().blocks
    expect(s.map((b) => b.type)).toEqual(['title', 'text', 'short_text', 'title', 'email'])
    // Исходная группа не тронута.
    expect(s.slice(0, 3).every((b) => b.groupId === gid)).toBe(true)
    // Новый вопрос — своя группа.
    expect(s[3]!.groupId).toBe(s[4]!.groupId)
    expect(s[3]!.groupId).not.toBe(gid)
  })

  it('makeField: одиночный → голое поле на месте; внутри группы → новой группой ниже', () => {
    const store = createBuilderStore()
    // Одиночный text-блок → голое поле на месте.
    store.getState().addBlock('text')
    const loneId = store.getState().blocks[0]!.id
    store.getState().makeField(loneId, 'email')
    expect(store.getState().blocks).toHaveLength(1)
    expect(store.getState().blocks[0]?.type).toBe('email')
    expect(store.getState().blocks[0]?.id).toBe(loneId)

    // Внутри группы (добавим контент к вопросу) → голое поле новой группой ниже.
    store.getState().addQuestionAfter(loneId, 'short_text') // [email, title, short_text]
    const titleId = store.getState().blocks[1]!.id
    store.getState().addBlockAfter(titleId, 'text') // контент в группу
    const contentId = store.getState().blocks[2]!.id
    const before = store.getState().blocks.length
    store.getState().makeField(contentId, 'number')
    const s = store.getState().blocks
    expect(s).toHaveLength(before + 1)
    expect(s[s.length - 1]?.type).toBe('number') // голое поле в конце новой группой
  })

  it('removeGroup сносит всю группу подписи (title владеет группой)', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // [title, short_text]
    store.getState().addBlockAfter(store.getState().blocks[0]!.id, 'text') // контент в группу
    expect(store.getState().blocks).toHaveLength(3)
    const titleId = store.getState().blocks[0]!.id

    store.getState().removeGroup(titleId)

    expect(store.getState().blocks).toHaveLength(0) // ушла вся группа
  })

  it('reorderBlocks: перенос строки — плоский, группы пересчитывает regroup', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // title, f1
    store.getState().addBlock('text') // одиночка снизу
    const b = store.getState().blocks
    expect(b.map((x) => x.type)).toEqual(['title', 'short_text', 'text'])
    const f1 = b[1]!.id
    const textId = b[2]!.id

    // Тащим ПОЛЕ из группы вниз на text → поле ушло, подпись осталась сиротой.
    store.getState().reorderBlocks(f1, textId)

    const s = store.getState().blocks
    expect(s.map((x) => x.type)).toEqual(['title', 'text', 'short_text'])
    // regroup: text теперь между подписью и полем → все трое снова одна группа.
    expect(s[0]!.groupId).toBe(s[2]!.groupId)
  })

  it('regroup: висячий контент — отдельные группы-одиночки (граница для дропа)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text')
    store.getState().addBlock('text')
    const b = store.getState().blocks
    // Два подряд text без закрывающего поля → РАЗНЫЕ группы (у каждого своя граница).
    expect(b[0]!.groupId).not.toBe(b[1]!.groupId)
  })

  it('regroup: подпись без поля — одиночка, лэйаут-ран за ней НЕ склеивается', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    store.getState().addBlock('text')
    store.getState().addBlock('heading')
    store.getState().addBlock('text')
    const b = store.getState().blocks
    // Группа = только «подпись…поле» или голое поле. Поля нет → все четыре одиночки:
    // между любыми соседями есть граница групп (туда можно уронить группу).
    const gids = b.map((x) => x.groupId)
    expect(new Set(gids).size).toBe(4)
  })

  it('regroup: подпись привязывается к полю ВВЕРХ от поля, контент выше подписи — чужой', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text') // standalone-абзац НАД вопросом
    store.getState().addBlock('title')
    store.getState().addBlock('short_text')
    const b = store.getState().blocks
    // title+поле — одна группа; text выше подписи в неё не входит.
    expect(b[1]!.groupId).toBe(b[2]!.groupId)
    expect(b[0]!.groupId).not.toBe(b[1]!.groupId)
  })

  it('regroup: подряд идущие подписи над полем — одна группа (title перебьёт label)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    store.getState().addBlock('label')
    store.getState().addBlock('email')
    const b = store.getState().blocks
    expect(b[0]!.groupId).toBe(b[2]!.groupId)
    expect(b[1]!.groupId).toBe(b[2]!.groupId)
  })

  it('regroup: контент, ведущий к полю, — в одной группе с полем', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // title, field
    const titleId = store.getState().blocks[0]!.id
    // Вставляем контентную строку между подписью и полем (лэйаут внутри группы).
    store.getState().addBlockAfter(titleId, 'text')
    const b = store.getState().blocks
    expect(b.map((x) => x.type)).toEqual(['title', 'text', 'short_text'])
    // Все три — одна группа: контент ведёт к полю.
    expect(b[0]!.groupId).toBe(b[1]!.groupId)
    expect(b[1]!.groupId).toBe(b[2]!.groupId)
  })

  it('reorderGroups: группу можно уронить между двумя одиночными text-блоками', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text') // text1 (одиночка)
    store.getState().addBlock('text') // text2 (одиночка)
    store.getState().addQuestionAfter(store.getState().blocks[1]!.id, 'email') // title, email
    const b = store.getState().blocks
    expect(b.map((x) => x.type)).toEqual(['text', 'text', 'title', 'email'])
    const gQuestion = b[2]!.groupId
    const gText2 = b[1]!.groupId

    // Тащим группу вопроса на позицию text2 → встаёт между text1 и text2.
    store.getState().reorderGroups(gQuestion, gText2)

    const s = store.getState().blocks
    expect(s.map((x) => x.type)).toEqual(['text', 'title', 'email', 'text'])
    // Группа цела (подпись+поле — один groupId), text-блоки — свои одиночки.
    expect(s[1]!.groupId).toBe(s[2]!.groupId)
    expect(s[0]!.groupId).not.toBe(s[1]!.groupId)
    expect(s[3]!.groupId).not.toBe(s[1]!.groupId)
  })

  it('reorderBlocks: standalone-контент дропом в середину группы становится её частью', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text') // одиночка над вопросом
    store.getState().addQuestionAfter(store.getState().blocks[0]!.id, 'short_text') // title, field
    const b = store.getState().blocks
    expect(b.map((x) => x.type)).toEqual(['text', 'title', 'short_text'])
    const textId = b[0]!.id
    const titleId = b[1]!.id

    // Тащим text вниз на title → ложится ПОСЛЕ него, между подписью и полем.
    store.getState().reorderBlocks(textId, titleId)

    const s = store.getState().blocks
    expect(s.map((x) => x.type)).toEqual(['title', 'text', 'short_text'])
    // Контент между подписью и полем — часть группы вопроса.
    expect(s[0]!.groupId).toBe(s[1]!.groupId)
    expect(s[1]!.groupId).toBe(s[2]!.groupId)
  })

  it('reorderGroups двигает группу целиком на позицию другой, внутренний порядок цел', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // группа1: title, short_text
    store.getState().addQuestionAfter(store.getState().blocks[1]!.id, 'email') // группа2: title, email
    const b = store.getState().blocks
    const g1 = b[0]!.groupId
    const g2 = b[2]!.groupId

    store.getState().reorderGroups(g1, g2)

    const s = store.getState().blocks
    expect(s.map((x) => x.type)).toEqual(['title', 'email', 'title', 'short_text'])
    expect(s[0]!.groupId).toBe(s[1]!.groupId)
    expect(s[2]!.groupId).toBe(s[3]!.groupId)
    expect(store.getState().dirty).toBe(true)

    // Та же группа / неизвестный id — no-op (dirty не трогаем).
    store.getState().markSaved()
    store.getState().reorderGroups(s[0]!.groupId, s[0]!.groupId)
    store.getState().reorderGroups('нет-такой', s[0]!.groupId)
    expect(store.getState().dirty).toBe(false)
  })

  it('changeBlockType — конверсия на месте (голое поле/лэйаут), id стабилен', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text')
    store.getState().updateBlock(store.getState().blocks[0]!.id, { text: 'Пропадёт у поля' })
    const id = store.getState().blocks[0]!.id

    const returned = store.getState().changeBlockType(id, 'single_choice')

    const s = store.getState()
    expect(s.blocks).toHaveLength(1) // не разбивает — один блок на месте
    expect(s.blocks[0]?.id).toBe(id)
    expect(s.blocks[0]?.type).toBe('single_choice')
    expect(s.blocks[0]?.text).toBe('') // поле текст не несёт — сброшен
    expect(s.blocks[0]?.settings?.options).toEqual([])
    expect(returned).toBe(id)
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
    store.getState().addBlock('short_text')
    store.getState().addBlock('email')
    store.getState().addBlock('number')
    const [a, b, c] = store.getState().blocks.map((x) => x.id)

    store.getState().reorderBlocks(a!, c!)
    expect(store.getState().blocks.map((x) => x.id)).toEqual([b, c, a])
    expect(store.getState().dirty).toBe(true)

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
    store.getState().moveOption(id, b!, 'up')
    expect(store.getState().blocks[0]!.settings!.options!.map((o) => o.id)).toEqual([b, a])
    expect(store.getState().dirty).toBe(false)
  })

  it('hydrate загружает схему и сбрасывает dirty/selection', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const schema: FormSchema = {
      schemaVersion: 2,
      // groupId уже канонический (g_<id поля>) — regroup его не меняет.
      blocks: [{ id: 'x', groupId: 'g_x', type: 'email' }],
    }

    store.getState().hydrate(schema)

    const s = store.getState()
    expect(s.blocks).toEqual(schema.blocks)
    expect(s.dirty).toBe(false)
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
    store.getState().hydrate({ schemaVersion: 2, blocks: [], submitLabel: 'Отправить ответ' })
    expect(store.getState().submitLabel).toBe('Отправить ответ')
  })

  it('setAfterSubmit правит экран «после отправки»; toSchema его несёт', () => {
    const store = createBuilderStore()
    store.getState().setAfterSubmit({
      thankYouText: 'Ждём вас на встрече!',
      redirectUrl: 'https://example.com/thanks',
    })

    const schema = store.getState().toSchema()
    expect(store.getState().dirty).toBe(true)
    expect(schema.thankYouText).toBe('Ждём вас на встрече!')
    expect(schema.redirectUrl).toBe('https://example.com/thanks')
    expect(formSchemaSchema.safeParse(schema).success).toBe(true)
  })

  it('setAfterSubmit — один шаг отмены на оба поля', () => {
    const store = createBuilderStore()
    store.getState().setAfterSubmit({ thankYouText: 'Спасибо!', redirectUrl: 'https://a.com' })

    store.getState().undo()
    expect(store.getState().thankYouText).toBe('')
    expect(store.getState().redirectUrl).toBe('')
  })

  it('setAfterSubmit теми же значениями — no-op: историю и dirty не трогает', () => {
    const store = createBuilderStore()
    store.getState().setAfterSubmit({ thankYouText: 'Спасибо!', redirectUrl: 'https://a.com' })
    store.getState().markSaved()
    const depth = store.getState().past.length

    store.getState().setAfterSubmit({ thankYouText: 'Спасибо!', redirectUrl: 'https://a.com' })
    expect(store.getState().past).toHaveLength(depth)
    expect(store.getState().dirty).toBe(false)
  })

  it('hydrate загружает поля экрана «после отправки» из схемы', () => {
    const store = createBuilderStore()
    store.getState().hydrate({
      schemaVersion: 2,
      blocks: [],
      thankYouText: 'Спасибо!',
      redirectUrl: 'https://example.com',
    })
    expect(store.getState().thankYouText).toBe('Спасибо!')
    expect(store.getState().redirectUrl).toBe('https://example.com')
  })

  it('markSaved снимает dirty', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    expect(store.getState().dirty).toBe(true)
    store.getState().markSaved()
    expect(store.getState().dirty).toBe(false)
  })

  it('toSchema отдаёт валидный по контракту v2 документ (вопрос-группа)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    store.getState().addBlock('short_text')
    store.getState().addBlock('single_choice')
    store.getState().updateBlock(store.getState().blocks[0]!.id, { text: 'Имя' })

    const schema = store.getState().toSchema()
    expect(schema.schemaVersion).toBe(2)
    expect(schema.blocks).toHaveLength(3)
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

  it('undo/redo восстанавливают поля экрана «после отправки»', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().setAfterSubmit({ thankYouText: 'Ждём вас!', redirectUrl: 'https://a.com' })

    store.getState().undo()
    expect(store.getState().thankYouText).toBe('')
    expect(store.getState().redirectUrl).toBe('')
    expect(store.getState().blocks).toHaveLength(1)

    store.getState().redo()
    expect(store.getState().thankYouText).toBe('Ждём вас!')
    expect(store.getState().redirectUrl).toBe('https://a.com')
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
    expect(store.getState().dirty).toBe(false)
    expect(store.getState().past).toEqual([])
    expect(store.getState().future).toEqual([])
  })

  it('новая правка после undo обрывает ветку redo', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('email')
    store.getState().undo()
    expect(store.getState().future).toHaveLength(1)

    store.getState().addBlock('number')
    expect(store.getState().future).toEqual([])
    store.getState().redo()
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['short_text', 'number'])
  })

  it('граничный no-op (moveBlock на краю) не пишет историю', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const before = store.getState().past.length
    store.getState().moveBlock(store.getState().blocks[0]!.id, 'up')
    expect(store.getState().past.length).toBe(before)
  })

  it('непрерывный ввод текста коалесится в один шаг отмены', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    const id = store.getState().blocks[0]!.id
    store.getState().updateBlock(id, { text: 'И' })
    store.getState().updateBlock(id, { text: 'Им' })
    store.getState().updateBlock(id, { text: 'Имя' })

    store.getState().undo()
    expect(store.getState().blocks[0]!.text).toBe('')
    store.getState().undo()
    expect(store.getState().blocks).toEqual([])
  })

  it('правки разных полей и дискретный required — отдельные шаги', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const id = store.getState().blocks[0]!.id
    store.getState().updateBlock(id, { settings: { placeholder: 'подсказка' } })
    store.getState().updateBlock(id, { required: true }) // дискретно — свой шаг
    store.getState().updateBlock(id, { settings: { placeholder: 'другая' } })

    store.getState().undo() // снимает последний placeholder
    expect(store.getState().blocks[0]!.settings?.placeholder).toBe('подсказка')
    expect(store.getState().blocks[0]!.required).toBe(true)
    store.getState().undo() // снимает required
    expect(store.getState().blocks[0]!.required).toBe(false)
  })

  it('hydrate очищает историю', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().hydrate({ schemaVersion: 2, blocks: [], submitLabel: '' })
    expect(store.getState().past).toEqual([])
    store.getState().undo()
    expect(store.getState().blocks).toEqual([])
  })

  it('undo убирает добавленный блок', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    expect(store.getState().blocks).toHaveLength(1)

    store.getState().undo()
    expect(store.getState().blocks).toEqual([])
  })
})
