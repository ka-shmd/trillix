import { describe, expect, it } from 'vitest'

import { formSchemaSchema, type FormSchema } from '@entities/formSchema'

import { canPairWithPrevious, createBuilderStore, planBlockDrop, remapDropTarget } from './store'

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

  it('reorderBlocks §4.4: инпут, уроненный внутрь чужой мульти-группы, приземляется под ней', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // title, f1
    store.getState().addBlock('text') // одиночка под группой
    store.getState().addBlock('email') // голое поле в конце
    const b = store.getState().blocks
    expect(b.map((x) => x.type)).toEqual(['title', 'short_text', 'text', 'email'])

    // Тащим email на f1 — «между подписью и полем» чужого вопроса (Д11).
    store.getState().reorderBlocks(b[3]!.id, b[1]!.id)

    const s = store.getState().blocks
    // Приземлился СРАЗУ ПОД группой (выше text-одиночки), не внутри неё.
    expect(s.map((x) => x.type)).toEqual(['title', 'short_text', 'email', 'text'])
    // Подпись осталась у прежнего поля, email — голое поле со своей группой:
    // колонки CSV и шаги воронки не переименованы.
    expect(s[0]!.groupId).toBe(s[1]!.groupId)
    expect(s[2]!.groupId).not.toBe(s[0]!.groupId)
  })

  it('reorderBlocks §4.4: подпись, уроненная между строк чужой мульти-группы, уезжает под неё', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // title, f1
    store.getState().addBlock('text')
    store.getState().addBlock('label') // сирота-подпись в конце
    const b = store.getState().blocks

    store.getState().reorderBlocks(b[3]!.id, b[1]!.id)

    const s = store.getState().blocks
    expect(s.map((x) => x.type)).toEqual(['title', 'short_text', 'label', 'text'])
    // Вопрос не перехвачен: группа по-прежнему «title + short_text».
    expect(s[0]!.groupId).toBe(s[1]!.groupId)
    expect(s[2]!.groupId).not.toBe(s[1]!.groupId)
  })

  it('§4.4 не мешает жесту «дать голому полю подпись» (группа из одного блока)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('email') // голое поле
    store.getState().addBlock('label')
    const [email, label] = store.getState().blocks.map((x) => x.id)

    store.getState().reorderBlocks(label!, email!)

    const s = store.getState().blocks
    expect(s.map((x) => x.type)).toEqual(['label', 'email'])
    expect(s[0]!.groupId).toBe(s[1]!.groupId) // подпись пристегнулась к полю
  })

  it('planBlockDrop: frameIds — будущий состав группы активного блока', () => {
    const store = createBuilderStore()
    store.getState().addBlock('email')
    store.getState().addBlock('label')
    const b = store.getState().blocks

    // Подпись летит над голое поле: рамка обнимет будущую пару «подпись+поле».
    const join = planBlockDrop(b, b[1]!.id, b[0]!.id)
    expect(join?.redirected).toBe(false)
    expect(join?.frameIds).toEqual([b[1]!.id, b[0]!.id])
  })

  it('planBlockDrop: при перенаправлении рамке отдаётся чужая группа; дроп-возврат — changed=false', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // title, f1
    store.getState().addBlock('email') // голое поле сразу под группой
    const b = store.getState().blocks

    const plan = planBlockDrop(b, b[2]!.id, b[1]!.id) // email — внутрь группы
    expect(plan?.redirected).toBe(true)
    expect(plan?.frameIds).toEqual([b[0]!.id, b[1]!.id])
    // Легальная точка — под группой, где email и так стоит: коммитить нечего.
    expect(plan?.changed).toBe(false)
  })

  it('remapDropTarget: щель раскрывается под чужой группой, а не внутри неё', () => {
    const store = createBuilderStore()
    store.getState().addBlock('email') // голое поле НАД группой
    store.getState().addQuestionAfter(store.getState().blocks[0]!.id, 'short_text') // title, f1
    store.getState().addBlock('number') // голое поле ПОД группой
    store.getState().addBlock('text') // контент в конце
    const [top, title, f1, below, txt] = store.getState().blocks
    const blocks = store.getState().blocks

    // Сверху: цель внутри группы → подмена на её последнюю строку (щель под группой).
    expect(remapDropTarget(blocks, top!.id, title!.id)).toBe(f1!.id)
    // Цель — последняя строка: дроп и так ляжет под группу, подмена не нужна.
    expect(remapDropTarget(blocks, top!.id, f1!.id)).toBeNull()
    // Снизу: цель внутри → строка сразу под группой (здесь — сам активный: «на месте»).
    expect(remapDropTarget(blocks, below!.id, f1!.id)).toBe(below!.id)
    // Снизу на подпись — легальный дроп НАД группой.
    expect(remapDropTarget(blocks, below!.id, title!.id)).toBeNull()
    // Контента правило не касается: text падает внутрь группы свободно.
    expect(remapDropTarget(blocks, txt!.id, f1!.id)).toBeNull()
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

  // --- Этап 13.2: клавиатурный поток ---

  it('addBlockAfterGroup вставляет строку ПОСЛЕ всей группы (Enter §3.2)', () => {
    const store = createBuilderStore()
    // Группа [title, text(контент), short_text] + одиночка ниже.
    store.getState().addQuestionAfter(null, 'short_text')
    const titleId = store.getState().blocks[0]!.id
    store.getState().addBlockAfter(titleId, 'text') // контент внутрь группы
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['title', 'text', 'short_text'])
    store.getState().markSaved()

    // Enter с контентного блока внутри группы → text ПОСЛЕ всей группы, не между.
    const contentId = store.getState().blocks[1]!.id
    const newId = store.getState().addBlockAfterGroup(contentId, 'text')

    const s = store.getState().blocks
    expect(s.map((b) => b.type)).toEqual(['title', 'text', 'short_text', 'text'])
    expect(s[3]!.id).toBe(newId)
    // Новая строка — вне исходной группы (своя одиночка).
    expect(s[3]!.groupId).not.toBe(s[0]!.groupId)
    expect(store.getState().dirty).toBe(true)
  })

  it('addBlockAfter (Shift+Enter) вставляет строку ВНУТРЬ группы', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // [title, short_text]
    const titleId = store.getState().blocks[0]!.id

    // Shift+Enter с подписи → контент сразу под ней, в той же группе.
    store.getState().addBlockAfter(titleId, 'text')

    const s = store.getState().blocks
    expect(s.map((b) => b.type)).toEqual(['title', 'text', 'short_text'])
    expect(s[1]!.groupId).toBe(s[0]!.groupId) // остался в группе вопроса
  })

  it('choice-вопрос (makeQuestion) рождается с одним пустым вариантом', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text')
    const id = store.getState().blocks[0]!.id
    store.getState().makeQuestion(id, 'single_choice')

    const field = store.getState().blocks.find((b) => b.type === 'single_choice')
    expect(field?.settings?.options).toHaveLength(1)
    expect(field?.settings?.options?.[0]?.label).toBe('')
  })

  it('choice-поле (addFieldAfter/makeField) рождается с одним пустым вариантом', () => {
    const store = createBuilderStore()
    const fieldId = store.getState().addFieldAfter(null, 'multi_choice')
    expect(store.getState().blocks.find((b) => b.id === fieldId)?.settings?.options).toHaveLength(1)

    store.getState().addBlock('text')
    const loneId = store.getState().blocks.find((b) => b.type === 'text')!.id
    store.getState().makeField(loneId, 'dropdown')
    expect(store.getState().blocks.find((b) => b.id === loneId)?.settings?.options).toHaveLength(1)
  })

  it('addBlock/changeBlockType оставляют choice с пустым списком (недособранный черновик)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    expect(store.getState().blocks[0]?.settings?.options).toEqual([])
  })

  it('addOptionAfter вставляет вариант сразу после текущего и возвращает id (Д5)', () => {
    const store = createBuilderStore()
    store.getState().addFieldAfter(null, 'single_choice') // рождается с 1 вариантом
    const blockId = store.getState().blocks[0]!.id
    const first = store.getState().blocks[0]!.settings!.options![0]!.id
    store.getState().addOption(blockId) // теперь [first, second]
    const second = store.getState().blocks[0]!.settings!.options![1]!.id
    store.getState().markSaved()

    // Enter на ПЕРВОМ варианте → новый ложится между first и second, а не в конец.
    const newId = store.getState().addOptionAfter(blockId, first)

    const opts = store.getState().blocks[0]!.settings!.options!
    expect(opts.map((o) => o.id)).toEqual([first, newId, second])
    expect(store.getState().dirty).toBe(true)
  })

  it('addOptionAfter на non-choice — no-op, dirty не поднимается', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const id = store.getState().blocks[0]!.id
    store.getState().markSaved()

    store.getState().addOptionAfter(id, 'opt_nope')
    expect(store.getState().dirty).toBe(false)
  })

  it('moveGroup переставляет группу целиком с соседней; каретка (id) стабильна', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // группа A: [title, short_text]
    store.getState().addQuestionAfter(null, 'email') // группа B: [title, email]
    let b = store.getState().blocks
    expect(b.map((x) => x.type)).toEqual(['title', 'short_text', 'title', 'email'])
    const aTitleId = b[0]!.id
    const bEmailId = b[3]!.id
    store.getState().markSaved()

    // Двигаем группу A вниз (по любому её блоку) — B встаёт первой.
    store.getState().moveGroup(aTitleId, 'down')
    b = store.getState().blocks
    expect(b.map((x) => x.type)).toEqual(['title', 'email', 'title', 'short_text'])
    // id блоков сохранились (каретка едет с группой): подпись A теперь третья строка.
    expect(b[1]!.id).toBe(bEmailId)
    expect(b[2]!.id).toBe(aTitleId)
    expect(store.getState().dirty).toBe(true)
  })

  it('moveGroup на границе полотна — no-op (dirty не трогает)', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text')
    store.getState().addQuestionAfter(null, 'email')
    const topId = store.getState().blocks[0]!.id
    store.getState().markSaved()

    store.getState().moveGroup(topId, 'up') // верхняя группа вверх — некуда
    expect(store.getState().dirty).toBe(false)
  })

  it('undo возвращает id блока, которого коснулся откат текста (§2.4)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    store.getState().addBlock('short_text')
    const titleId = store.getState().blocks[0]!.id
    store.getState().updateBlock(titleId, { text: 'Имя' })

    const focus = store.getState().undo() // откат правки текста подписи
    expect(focus).toBe(titleId)
    expect(store.getState().blocks[0]?.text).toBe('')
  })

  it('undo удаления в хвосте фокусирует соседа; undo единственной вставки → null', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text') // единственная вставка
    // Откат вставки: список пустеет → фокусировать нечего (каретка уйдёт на заголовок).
    expect(store.getState().undo()).toBeNull()

    // Две строки + третья; откат третьей → сосед (последняя оставшаяся).
    store.getState().redo() // вернуть short_text
    store.getState().addBlock('email')
    const emailId = store.getState().blocks[1]!.id
    store.getState().addBlock('number') // третья, в хвосте
    expect(store.getState().undo()).toBe(emailId) // сосед — предыдущий хвост
  })

  it('redo возвращает id восстановленного блока', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    const id = store.getState().blocks[0]!.id
    store.getState().undo() // убрали
    expect(store.getState().redo()).toBe(id) // вернули — каретка на него
  })
})

describe('createBuilderStore — half-ширина и колонки вариантов (фаза 13.6)', () => {
  // Полотно из голых полей: каждое — своя группа.
  const fields = (...types: ('short_text' | 'email' | 'phone' | 'long_text' | 'single_choice' | 'dropdown')[]) => {
    const store = createBuilderStore()
    for (const t of types) store.getState().addBlock(t)
    return store
  }
  const widths = (store: ReturnType<typeof createBuilderStore>) =>
    store.getState().blocks.map((b) => b.settings?.width ?? 'full')

  it('pairWithPrevious ставит обе группы в half одним шагом undo', () => {
    const store = fields('short_text', 'email')
    const second = store.getState().blocks[1]!
    expect(canPairWithPrevious(store.getState().blocks, second.id)).toBe(true)

    store.getState().pairWithPrevious(second.id)
    expect(widths(store)).toEqual(['half', 'half'])

    store.getState().undo()
    expect(widths(store)).toEqual(['full', 'full'])
  })

  it('canPairWithPrevious: первая группа и не-whitelist сосед — нельзя', () => {
    const store = fields('long_text', 'short_text')
    const [first, second] = store.getState().blocks
    expect(canPairWithPrevious(store.getState().blocks, first!.id)).toBe(false)
    // Предыдущая группа — long_text (не whitelist).
    expect(canPairWithPrevious(store.getState().blocks, second!.id)).toBe(false)
    store.getState().pairWithPrevious(second!.id)
    expect(widths(store)).toEqual(['full', 'full'])
  })

  it('третьему в ряду места нет: предыдущая уже в паре — no-op', () => {
    const store = fields('short_text', 'email', 'short_text')
    const [, b, c] = store.getState().blocks
    store.getState().pairWithPrevious(b!.id)
    expect(canPairWithPrevious(store.getState().blocks, c!.id)).toBe(false)
    store.getState().pairWithPrevious(c!.id)
    expect(widths(store)).toEqual(['half', 'half', 'full'])
  })

  it('setFullWidth разворачивает и осиротевшего соседа по ряду', () => {
    const store = fields('short_text', 'email')
    const [a, b] = store.getState().blocks
    store.getState().pairWithPrevious(b!.id)
    store.getState().setFullWidth(a!.id)
    expect(widths(store)).toEqual(['full', 'full'])
  })

  it('удаление соседа возвращает вдовца на всю ширину', () => {
    const store = fields('short_text', 'email')
    const [a, b] = store.getState().blocks
    store.getState().pairWithPrevious(b!.id)
    store.getState().removeGroup(a!.id)
    expect(widths(store)).toEqual(['full'])
  })

  it('перенос группы из пары разворачивает обе (сосед уехал)', () => {
    const store = fields('short_text', 'email', 'long_text')
    const [a, b] = store.getState().blocks
    store.getState().pairWithPrevious(b!.id)
    store.getState().moveGroup(a!.id, 'down') // a уезжает за long_text? нет — a меняется с b, пара остаётся смежной
    // Смежная перестановка внутри пары пару не рвёт (обе half и рядом).
    expect(widths(store).filter((w) => w === 'half')).toHaveLength(2)

    // А вот отъезд b вниз за long_text рвёт пару: между половинами чужая группа.
    store.getState().moveGroup(store.getState().blocks[1]!.id, 'down')
    expect(widths(store)).toEqual(['full', 'full', 'full'])
  })

  it('смена типа вне whitelist снимает ширину у обоих; внутри whitelist пара цела', () => {
    const store = fields('short_text', 'email')
    const [a, b] = store.getState().blocks
    store.getState().pairWithPrevious(b!.id)

    store.getState().changeBlockType(a!.id, 'phone') // внутри whitelist
    expect(widths(store)).toEqual(['half', 'half'])

    store.getState().changeBlockType(a!.id, 'long_text') // вне whitelist
    expect(widths(store)).toEqual(['full', 'full'])
  })

  it('placeGroupBeside ставит группу вплотную к цели и спаривает', () => {
    const store = fields('short_text', 'long_text', 'email')
    const [a, , c] = store.getState().blocks
    store.getState().placeGroupBeside(c!.groupId, a!.groupId, 'after')

    const s = store.getState()
    expect(s.blocks.map((b) => b.type)).toEqual(['short_text', 'email', 'long_text'])
    expect(s.blocks.map((b) => b.settings?.width ?? 'full')).toEqual(['half', 'half', 'full'])
  })

  it('placeGroupBeside в занятую пару и на не-whitelist — no-op', () => {
    const store = fields('short_text', 'email', 'short_text', 'long_text')
    const [a, b, c, d] = store.getState().blocks
    store.getState().pairWithPrevious(b!.id)
    store.getState().markSaved()

    store.getState().placeGroupBeside(c!.groupId, a!.groupId, 'after') // цель в паре
    store.getState().placeGroupBeside(c!.groupId, d!.groupId, 'after') // цель не whitelist
    const s = store.getState()
    expect(s.dirty).toBe(false)
    expect(s.blocks.map((x) => x.id)).toEqual([a!.id, b!.id, c!.id, d!.id])
  })

  it('setOptionColumns: 2 ставится, 1 снимает ключ, dropdown — no-op', () => {
    const store = fields('single_choice', 'dropdown')
    const [choice, dropdown] = store.getState().blocks

    store.getState().setOptionColumns(choice!.id, 2)
    expect(store.getState().blocks[0]?.settings?.optionColumns).toBe(2)

    store.getState().setOptionColumns(choice!.id, 1)
    expect(store.getState().blocks[0]?.settings).not.toHaveProperty('optionColumns')

    store.getState().markSaved()
    store.getState().setOptionColumns(dropdown!.id, 2)
    expect(store.getState().dirty).toBe(false)
    expect(store.getState().blocks[1]?.settings).not.toHaveProperty('optionColumns')
  })

  it('смена типа single→multi переносит колонки, →dropdown роняет', () => {
    const store = fields('single_choice')
    const id = store.getState().blocks[0]!.id
    store.getState().setOptionColumns(id, 2)

    store.getState().changeBlockType(id, 'multi_choice')
    expect(store.getState().blocks[0]?.settings?.optionColumns).toBe(2)

    store.getState().changeBlockType(id, 'dropdown')
    expect(store.getState().blocks[0]?.settings).not.toHaveProperty('optionColumns')
  })

  it('hydrate нормализует одинокую половину в full', () => {
    const store = createBuilderStore()
    const schema = formSchemaSchema.parse({
      schemaVersion: 2,
      blocks: [{ id: 'b1', groupId: 'g_b1', type: 'short_text', settings: { width: 'half' } }],
    } satisfies FormSchema)
    store.getState().hydrate(schema)
    expect(store.getState().blocks[0]?.settings).not.toHaveProperty('width')
    expect(store.getState().dirty).toBe(false)
  })

  it('toSchema после спаривания проходит валидацию контракта', () => {
    const store = fields('short_text', 'email')
    store.getState().pairWithPrevious(store.getState().blocks[1]!.id)
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })
})
