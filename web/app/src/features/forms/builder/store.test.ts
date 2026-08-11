import { describe, expect, it } from 'vitest'

import {
  formSchemaSchema,
  type FormSchema,
  MAX_COLUMNS,
  plainText,
  SCHEMA_VERSION,
  textFromString,
} from '@entities/formSchema'
import { groupBlocks, packOptionRows, packRows, splitPages } from '@fields/groups'

import {
  captionLoss,
  createBuilderStore,
  DOCUMENT_FIELDS,
  planBlockDrop,
  rowPosition,
} from './store'

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

  // Дефолты типа лежат литералом в файле типа (kinds/<type>.tsx) и живут весь срок
  // вкладки. Спред копирует ссылку, поэтому без клона все блоки типа делили бы ОДИН
  // объект настроек и один массив вариантов; первая же правка «на месте» испортила бы
  // не блок, а дефолт типа — и следующий новый список приехал бы с чужими вариантами.
  // Находка ревью этапа 16.1в; сегодня стор пишет настройки иммутабельно, поэтому
  // сторож ловит именно возврат ловушки, а не текущую поломку.
  it('два блока одного типа не делят объект настроек', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    store.getState().addBlock('single_choice')
    const [first, second] = store.getState().blocks

    expect(first?.settings).not.toBe(second?.settings)
    expect(first?.settings?.options).not.toBe(second?.settings?.options)
    expect(second?.settings?.options).toEqual(first?.settings?.options)
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

  it('choice-блок стартует с пустым списком, non-choice — без опций', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    store.getState().addBlock('number')

    const [choice, number] = store.getState().blocks
    // В схеме живут только настоящие варианты: пустой список = «автор ещё ничего не
    // набрал», а место для набора даёт призрак в редакторе, которого здесь нет.
    expect(choice?.settings?.options).toEqual([])
    expect(number?.settings?.options).toBeUndefined()
  })

  it('updateBlock патчит только целевой блок (text у подписи)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    store.getState().addBlock('title')
    const [first, second] = store.getState().blocks
    store.getState().markSaved()

    store.getState().updateBlock(first!.id, { text: textFromString('Имя') })

    const s = store.getState()
    expect(plainText(s.blocks[0]?.text)).toBe('Имя')
    expect(s.blocks[1]?.id).toBe(second!.id)
    expect(plainText(s.blocks[1]?.text)).toBe('')
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
    store.getState().updateBlock(id, { text: textFromString('Ваше имя') })
    store.getState().markSaved()

    const focus = store.getState().makeQuestion(id, 'short_text')

    const s = store.getState()
    expect(s.blocks).toHaveLength(2)
    // Набранный текст стал подписью (id сохранён), под ней — поле.
    expect(s.blocks[0]?.id).toBe(id)
    expect(s.blocks[0]?.type).toBe('title')
    expect(plainText(s.blocks[0]?.text)).toBe('Ваше имя')
    expect(s.blocks[1]?.type).toBe('short_text')
    expect(plainText(s.blocks[1]?.text)).toBe('')
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
    expect(plainText(s.blocks[1]?.text)).toBe('')
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

  it('regroup: подпись у вопроса ровно одна — ближайшая к полю', () => {
    // Собранная группа «подпись + поле» целая: второй заголовок в неё не входит,
    // он остаётся одиночкой (решение владельца 2026-07-26). Иначе осиротевшая
    // подпись мёртвого вопроса, оказавшись над следующим, становилась его вторым
    // заголовком и перебивала настоящий в CSV и воронке.
    const store = createBuilderStore()
    store.getState().addBlock('title')
    store.getState().addBlock('label')
    store.getState().addBlock('email')
    const b = store.getState().blocks
    expect(b[1]!.groupId).toBe(b[2]!.groupId) // label + email — вопрос
    expect(b[0]!.groupId).not.toBe(b[2]!.groupId) // title сам по себе
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
    const gText1 = b[0]!.groupId

    // Тащим группу вопроса ПОД text1 → встаёт между text1 и text2.
    store.getState().reorderGroups(gQuestion, gText1)

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
    store
      .getState()
      .updateBlock(store.getState().blocks[0]!.id, { text: textFromString('Пропадёт у поля') })
    const id = store.getState().blocks[0]!.id

    const returned = store.getState().changeBlockType(id, 'single_choice')

    const s = store.getState()
    expect(s.blocks).toHaveLength(1) // не разбивает — один блок на месте
    expect(s.blocks[0]?.id).toBe(id)
    expect(s.blocks[0]?.type).toBe('single_choice')
    expect(plainText(s.blocks[0]?.text)).toBe('') // поле текст не несёт — сброшен
    expect(s.blocks[0]?.settings?.options).toEqual([]) // варианты набирает автор
    expect(returned).toBe(id)
  })

  it('updateBlock на несуществующем блоке — no-op (ни истории, ни dirty)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    store.getState().markSaved()
    const before = store.getState()

    // Так приходит отложенный колбэк, переживший свой блок: загрузка картинки
    // дописывает imageKey уже после того, как блок удалили.
    store.getState().updateBlock('нет-такого', { text: textFromString('привет') })

    const after = store.getState()
    expect(after.dirty).toBe(false)
    expect(after.past.length).toBe(before.past.length)
    // Ссылка на массив не меняется — подписка автосейва не будится.
    expect(after.blocks).toBe(before.blocks)
  })

  it('updateBlock без фактического изменения — no-op', () => {
    const store = createBuilderStore()
    const id = store.getState().addBlockAfter(null, 'title')
    store.getState().updateBlock(id, { text: textFromString('Имя') })
    store.getState().markSaved()
    const before = store.getState()

    store.getState().updateBlock(id, { text: textFromString('Имя') })
    store.getState().updateBlock(id, { required: false })

    const after = store.getState()
    expect(after.dirty).toBe(false)
    expect(after.past.length).toBe(before.past.length)
    expect(after.blocks).toBe(before.blocks)
  })

  // §5.4 спеки: имя дал автор, и относится оно к вопросу, а не к тому, чем на него
  // отвечают. Плейсхолдер терялся здесь же и по той же причине — одно правило чинит
  // оба случая.
  it('changeBlockType сохраняет имя и плейсхолдер, пока новый тип их несёт', () => {
    const store = createBuilderStore()
    const id = store.getState().addBlockAfter(null, 'short_text')
    store.getState().updateBlock(id, { name: 'fio', settings: { placeholder: 'Иван' } })

    store.getState().changeBlockType(id, 'email')

    const b = store.getState().blocks[0]!
    expect(b.name).toBe('fio')
    expect(b.settings?.placeholder).toBe('Иван')
  })

  // Правила логики (фаза 21) переживают смену типа по тому же доводу, что имя:
  // «показывать, если» относится к ВОПРОСУ, а не к тому, чем на него отвечают. Без
  // этого первая же смена типа стирала бы настройку молча — конверсия собирает блок из
  // дефолтов нового типа и переносит поля поимённо.
  it('changeBlockType сохраняет visibleIf и requiredIf', () => {
    const store = createBuilderStore()
    const src = store.getState().addBlockAfter(null, 'short_text')
    const id = store.getState().addBlockAfter(src, 'short_text')
    const rule = { all: [{ blockId: src, op: 'answered' as const }] }
    store.getState().updateBlock(id, { visibleIf: rule, requiredIf: rule })

    store.getState().changeBlockType(id, 'email')

    const b = store.getState().blocks.find((x) => x.id === id)!
    expect(b.visibleIf).toEqual(rule)
    expect(b.requiredIf).toEqual(rule)
  })

  // Обязательности по условию у неотвечаемого типа не бывает (схема её запрещает) —
  // роняется вместе с обычной required. Видимость остаётся: прятать по условию можно и
  // заголовок, и абзац.
  it('changeBlockType роняет requiredIf на неотвечаемом типе, но не visibleIf', () => {
    const store = createBuilderStore()
    const src = store.getState().addBlockAfter(null, 'short_text')
    const id = store.getState().addBlockAfter(src, 'short_text')
    const rule = { all: [{ blockId: src, op: 'answered' as const }] }
    store.getState().updateBlock(id, { visibleIf: rule, requiredIf: rule })

    store.getState().changeBlockType(id, 'heading')

    const b = store.getState().blocks.find((x) => x.id === id)!
    expect(b.requiredIf).toBeUndefined()
    expect(b.visibleIf).toEqual(rule)
  })

  // Новый тип ответов не собирает — имени нечего называть, и схема его у такого типа
  // запрещает: остаться оно не может даже «на всякий случай».
  it('changeBlockType роняет имя на неотвечаемом типе', () => {
    const store = createBuilderStore()
    const id = store.getState().addBlockAfter(null, 'short_text')
    store.getState().updateBlock(id, { name: 'fio' })

    store.getState().changeBlockType(id, 'heading')

    expect(store.getState().blocks[0]!.name).toBeUndefined()
  })

  // Шкала плейсхолдера не показывает — переносить его туда значило бы положить в
  // документ ключ, которого автор на полотне не увидит и не сотрёт.
  it('changeBlockType роняет плейсхолдер на типе, который его не носит', () => {
    const store = createBuilderStore()
    const id = store.getState().addBlockAfter(null, 'short_text')
    store.getState().updateBlock(id, { settings: { placeholder: 'Иван' } })

    store.getState().changeBlockType(id, 'scale')

    expect(store.getState().blocks[0]!.settings?.placeholder).toBeUndefined()
  })

  it('changeBlockType на несуществующем блоке — no-op', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().markSaved()

    store.getState().changeBlockType('нет-такого', 'email')

    expect(store.getState().blocks[0]?.type).toBe('short_text')
    expect(store.getState().dirty).toBe(false)
  })

  it('reorderBlocks ставит блок ПОСЛЕ адреса, null — первым (dnd)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('email')
    store.getState().addBlock('number')
    const [a, b, c] = store.getState().blocks.map((x) => x.id)

    store.getState().reorderBlocks(a!, c!)
    expect(store.getState().blocks.map((x) => x.id)).toEqual([b, c, a])
    expect(store.getState().dirty).toBe(true)

    store.getState().reorderBlocks(a!, null) // адрес null — встать первым
    expect(store.getState().blocks.map((x) => x.id)).toEqual([a, b, c])

    // Свой же id, неизвестный адрес и адрес «там, где уже стою» — no-op.
    store.getState().markSaved()
    store.getState().reorderBlocks(b!, b!)
    store.getState().reorderBlocks('нет', c!)
    store.getState().reorderBlocks(b!, a!)
    expect(store.getState().blocks.map((x) => x.id)).toEqual([a, b, c])
    expect(store.getState().dirty).toBe(false)
  })

  // Фаза 15 (§4.1 спеки) сняла замок «отвечаемый блок и подпись приземляются ПОД
  // чужой мульти-группой»: строка роняется куда угодно, а последствие (кража
  // подписи) называется вслух — см. captionLoss ниже.
  it('reorderBlocks: поле, уроненное между подписью и полем чужого вопроса, встаёт туда', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // title, f1
    store.getState().addBlock('text') // одиночка под группой
    store.getState().addBlock('email') // голое поле в конце
    const b = store.getState().blocks
    expect(b.map((x) => x.type)).toEqual(['title', 'short_text', 'text', 'email'])

    // Тащим email под подпись — «между подписью и полем» чужого вопроса.
    store.getState().reorderBlocks(b[3]!.id, b[0]!.id)

    const s = store.getState().blocks
    expect(s.map((x) => x.type)).toEqual(['title', 'email', 'short_text', 'text'])
    // Заголовок достался пришельцу (он ближайший снизу), прежнее поле осталось
    // голым — ровно то, что описывает §4.3 спеки.
    expect(s[0]!.groupId).toBe(s[1]!.groupId)
    expect(s[2]!.groupId).not.toBe(s[0]!.groupId)
  })

  it('reorderBlocks: подпись, уроненная между строк чужого вопроса, забирает его поле', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // title, f1
    store.getState().addBlock('text')
    store.getState().addBlock('label') // сирота-подпись в конце
    const b = store.getState().blocks

    store.getState().reorderBlocks(b[3]!.id, b[0]!.id)

    const s = store.getState().blocks
    expect(s.map((x) => x.type)).toEqual(['title', 'label', 'short_text', 'text'])
    // Подпись ровно одна — ближайшая к полю (regroup): группа теперь «label + поле»,
    // прежний заголовок остался одиночкой.
    expect(s[1]!.groupId).toBe(s[2]!.groupId)
    expect(s[0]!.groupId).not.toBe(s[1]!.groupId)
  })

  it('перенос не мешает жесту «дать голому полю подпись» (группа из одного блока)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('email') // голое поле
    store.getState().addBlock('label')
    const [, label] = store.getState().blocks.map((x) => x.id)

    store.getState().reorderBlocks(label!, null)

    const s = store.getState().blocks
    expect(s.map((x) => x.type)).toEqual(['label', 'email'])
    expect(s[0]!.groupId).toBe(s[1]!.groupId) // подпись пристегнулась к полю
  })

  it('planBlockDrop: groupIds — вопрос, в который войдёт активный блок', () => {
    const store = createBuilderStore()
    store.getState().addBlock('email')
    store.getState().addBlock('label')
    const b = store.getState().blocks

    // Подпись летит над голое поле: рейл зажжётся у пары «подпись+поле», которой
    // ещё нет — вопрос рождается этим самым дропом.
    const join = planBlockDrop(b, b[1]!.id, null)
    expect(join?.groupIds).toEqual([b[1]!.id, b[0]!.id])
  })

  it('planBlockDrop: одиночка остаётся одиночкой — зажигать нечего', () => {
    const store = createBuilderStore()
    store.getState().addBlock('email')
    store.getState().addBlock('number')
    const b = store.getState().blocks

    // Два голых поля: перестановка их не роднит, каждое само себе вопрос.
    expect(planBlockDrop(b, b[1]!.id, null)?.groupIds).toEqual([])
  })

  it('planBlockDrop: дроп внутрь чужого вопроса — плоский сплайс по адресу', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // title, f1
    store.getState().addBlock('email') // голое поле сразу под группой
    const b = store.getState().blocks

    const plan = planBlockDrop(b, b[2]!.id, b[0]!.id) // email — между подписью и полем
    expect(plan!.blocks.map((x) => x.type)).toEqual(['title', 'email', 'short_text'])
    // Вопрос = группа, в которую войдёт САМ активный блок: заголовок достаётся ему.
    expect(plan!.groupIds).toEqual([b[0]!.id, b[2]!.id])
  })

  // captionLoss (§4.3 спеки фазы 15) — цена свободы строки ответа: правка, после
  // которой у живого поля не осталось заголовка. Функция чистая и считает по двум
  // раскладкам; тост и подсветку показывает полотно.
  describe('captionLoss', () => {
    // Вопрос «Имя» и голое поле под ним — исходник трёх сценариев ниже.
    const canvas = () => {
      const store = createBuilderStore()
      store.getState().addQuestionAfter(null, 'short_text') // title, short_text
      const [title] = store.getState().blocks
      store.getState().updateBlock(title!.id, { text: textFromString('Имя') })
      store.getState().addBlock('email') // голое поле в конце
      const [cap, field, bare] = store.getState().blocks
      return { store, cap: cap!, field: field!, bare: bare! }
    }

    it('перенос: поле, уведённое из своего вопроса, остаётся без заголовка', () => {
      const { store, field } = canvas()
      const before = store.getState().blocks

      store.getState().moveBlock(field.id, 'up') // поле уехало ВЫШЕ своей подписи

      expect(captionLoss(before, store.getState().blocks)).toEqual([
        { id: field.id, caption: 'Имя' },
      ])
    })

    it('дроп: чужое поле между подписью и полем крадёт заголовок у прежнего', () => {
      const { store, cap, field, bare } = canvas()
      const before = store.getState().blocks

      // Прогноз драга: сырая раскладка planBlockDrop (groupId там ещё старые) —
      // именно её полотно отдаёт в подсветку жертвы, не дожидаясь дропа.
      const plan = planBlockDrop(before, bare.id, cap.id)

      expect(captionLoss(before, plan!.blocks)).toEqual([{ id: field.id, caption: 'Имя' }])
    })

    it('удаление подписи: её поле остаётся без заголовка', () => {
      const { store, cap, field } = canvas()
      const before = store.getState().blocks

      store.getState().removeBlock(cap.id)

      expect(captionLoss(before, store.getState().blocks)).toEqual([
        { id: field.id, caption: 'Имя' },
      ])
    })

    it('удалённому полю терять нечего: потери нет', () => {
      const { store, field } = canvas()
      const before = store.getState().blocks

      store.getState().removeBlock(field.id)

      expect(captionLoss(before, store.getState().blocks)).toEqual([])
    })

    it('перенос вопроса целиком заголовка не теряет', () => {
      const { store, cap } = canvas()
      const before = store.getState().blocks

      store.getState().moveGroup(cap.id, 'down')

      expect(captionLoss(before, store.getState().blocks)).toEqual([])
    })

    it('поле, у которого заголовка и не было, в потерю не попадает', () => {
      const store = createBuilderStore()
      store.getState().addBlock('text') // одиночный абзац
      store.getState().addBlock('email') // голое поле под ним
      const before = store.getState().blocks

      store.getState().moveBlock(before[1]!.id, 'up')

      expect(captionLoss(before, store.getState().blocks)).toEqual([])
    })
  })

  // Вертикальный дроп обязан бит СНИМАТЬ (§13). Он же его и рождал: блок, унесённый из
  // ряда внутрь чужого вопроса, отдавал свой бит голове ЭТОГО вопроса (reanchorRowBits
  // писался под другой случай — «полю дали заголовок»), и вопрос вставал справа от
  // предыдущего. Из вертикального дропа возникал ряд, которого никто не просил, — то,
  // что владелец видел как склеивание блоков вокруг ряда (2026-08-03).
  it('блок, унесённый из ряда в чужой вопрос, не отдаёт ему бит ряда', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text') // левый участник ряда
    store.getState().addBlock('text') // правый участник — он и понесёт бит
    const [x, y] = store.getState().blocks
    store.getState().placeInRow(y!.groupId, x!.groupId, 2, true)
    store.getState().addQuestionAfter(null, 'short_text') // вопрос A
    store.getState().addQuestionAfter(null, 'email') // вопрос B
    const capB = store.getState().blocks.filter((b) => b.type === 'title')[1]!

    store.getState().reorderBlocks(y!.id, capB.id)

    const blocks = store.getState().blocks
    // Блок уехал внутрь вопроса B (дроп туда законен с фазы 15) — но РЯДА из этого не
    // возникло: ни одного бита на полотне не осталось.
    expect(blocks.every((b) => b.settings?.column === undefined)).toBe(true)
    expect(packRows(groupBlocks(blocks)).every((r) => r.length === 1)).toBe(true)
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

  // Подпись — ручка вопроса во всех жестах: мусорка сносит группу, драг тащит группу,
  // Alt+↑↓ двигает вопрос. «Дублировать» из её попапа обязано значить то же (фаза 16,
  // §4.2): копия одной подписи легла бы вторым заголовком вплотную к своему вопросу —
  // состояние, которое полотно запрещает как молчаливую подмену имени вопроса.
  it('duplicateBlock на подписи копирует вопрос целиком', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    store.getState().addBlock('short_text')
    const caption = store.getState().blocks[0]!

    store.getState().duplicateBlock(caption.id)

    const s = store.getState()
    expect(s.blocks.map((b) => b.type)).toEqual(['title', 'short_text', 'title', 'short_text'])
    // Копия — свой вопрос, а не продолжение исходного.
    expect(s.blocks[2]!.groupId).not.toBe(s.blocks[0]!.groupId)
    expect(s.blocks[2]!.groupId).toBe(s.blocks[3]!.groupId)
  })

  it('duplicateBlock на одинокой подписи копирует только её', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    const caption = store.getState().blocks[0]!

    store.getState().duplicateBlock(caption.id)

    expect(store.getState().blocks.map((b) => b.type)).toEqual(['title', 'title'])
  })

  // Единственный вход — попап варианта (фаза 16, решение 7).
  it('duplicateOption кладёт копию под оригиналом и даёт ей НОВЫЙ id', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    const block = store.getState().blocks[0]!
    const a = store.getState().addOption(block.id, 'Соцсети')
    store.getState().addOption(block.id, 'Реклама')

    const copy = store.getState().duplicateOption(block.id, a)

    const options = store.getState().blocks[0]!.settings!.options!
    expect(options.map((o) => o.label)).toEqual(['Соцсети', 'Соцсети', 'Реклама'])
    // Ответы ключуются id варианта: копия с чужим id молча присвоила бы себе его ответы.
    expect(copy).toBe(options[1]!.id)
    expect(copy).not.toBe(a)
  })

  it('duplicateOption на чужом варианте — no-op', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    const block = store.getState().blocks[0]!
    store.getState().addOption(block.id, 'Соцсети')
    const before = store.getState().blocks

    expect(store.getState().duplicateOption(block.id, 'нет-такого')).toBeNull()
    expect(store.getState().blocks).toBe(before)
  })

  it('addOption добавляет пустой вариант choice-блоку', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    const id = store.getState().blocks[0]!.id
    store.getState().markSaved()

    const newId = store.getState().addOption(id)

    const opts = store.getState().blocks[0]?.settings?.options
    expect(opts).toHaveLength(1)
    expect(opts?.[0]?.label).toBe('')
    expect(opts?.[0]?.id).toBe(newId) // id возвращается — по нему ставят каретку
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
      schemaVersion: SCHEMA_VERSION,
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
    store
      .getState()
      .hydrate({ schemaVersion: SCHEMA_VERSION, blocks: [], submitLabel: 'Отправить ответ' })
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

  // ОФОРМЛЕНИЕ ЕДЕТ НАСКВОЗЬ (фаза 22, слайс 2). Способа изменить его в этом слайсе
  // нет — панель приезжает слайсом 3, — но контракт PATCH /forms/{id} поле уже
  // принимает. Без переноса через стор существовал бы путь «записал оформление
  // запросом → открыл билдер → автосейв молча стёр»: toSchema собирает документ из
  // полей стора, и чего в сторе нет, того в сохранённой схеме не будет.
  it('hydrate → toSchema не теряет оформление, которого редактор не знает', () => {
    const store = createBuilderStore()
    const design = {
      theme: 'dark',
      palette: { accent: '#00aa55' },
      layout: { fontSize: 18 },
    } as const

    store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks: [], design })
    expect(store.getState().toSchema().design).toEqual(design)
  })

  it('форма без оформления не получает ключ design', () => {
    // Контракт фазы: документ, которого оформление не касалось, обязан остаться
    // байт в байт прежним. Пустой объект тут был бы правкой документа на пустом месте.
    const store = createBuilderStore()
    store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks: [] })
    expect('design' in store.getState().toSchema()).toBe(false)
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
      schemaVersion: SCHEMA_VERSION,
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

  it('toSchema отдаёт валидный по контракту документ (вопрос-группа)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    store.getState().addBlock('short_text')
    store.getState().addBlock('single_choice')
    store.getState().updateBlock(store.getState().blocks[0]!.id, { text: textFromString('Имя') })

    const schema = store.getState().toSchema()
    expect(schema.schemaVersion).toBe(SCHEMA_VERSION)
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
    store.getState().updateBlock(id, { text: textFromString('И') })
    store.getState().updateBlock(id, { text: textFromString('Им') })
    store.getState().updateBlock(id, { text: textFromString('Имя') })

    store.getState().undo()
    expect(plainText(store.getState().blocks[0]!.text)).toBe('')
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

  // Демо-критерий этапа 16.4: имя из двадцати символов — один шаг Mod+Z, а не
  // двадцать. Первый потребитель склейки ВНЕ settings (§4.6 спеки).
  it('набор имени вопроса коалесится в один шаг отмены', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    const id = store.getState().blocks[0]!.id
    for (const n of ['f', 'fi', 'fio']) store.getState().updateBlock(id, { name: n })

    store.getState().undo()
    expect(store.getState().blocks[0]!.name).toBeUndefined()
    store.getState().undo()
    expect(store.getState().blocks).toEqual([])
  })

  // Имя и текст — разные поля, и общий шаг откатывал бы вместе с именем весь
  // набранный текст. Проверяется на ОДНОМ блоке (согласие несёт и text, и name):
  // на разных блоках теги расходятся по id, и ключевая часть тега не сторожится
  // вовсе — тест был зелёным при любом её устройстве (находка ревью 16.4).
  it('имя и текст в ОДИН блок — разные шаги отмены', () => {
    const store = createBuilderStore()
    const id = store.getState().addBlockAfter(null, 'consent')
    store.getState().updateBlock(id, { text: textFromString('Соглашаюсь с обработкой') })
    store.getState().updateBlock(id, { name: 'consent' })

    store.getState().undo()
    const after = store.getState().blocks[0]!
    expect(after.name).toBeUndefined()
    expect(plainText(after.text)).toBe('Соглашаюсь с обработкой')
  })

  it('hydrate очищает историю', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().hydrate({ schemaVersion: SCHEMA_VERSION, blocks: [], submitLabel: '' })
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

  it('choice рождается с пустым списком любым путём — пустых вариантов в схеме нет', () => {
    // Место для набора даёт призрак в редакторе (BlockRow), а не заготовленный
    // пустой вариант: иначе он уезжал бы в опубликованную форму пустой карточкой.
    const store = createBuilderStore()
    store.getState().addBlock('text')
    const id = store.getState().blocks[0]!.id
    store.getState().makeQuestion(id, 'single_choice')
    expect(
      store.getState().blocks.find((b) => b.type === 'single_choice')?.settings?.options,
    ).toEqual([])

    store.getState().addFieldAfter(null, 'multi_choice')
    expect(
      store.getState().blocks.find((b) => b.type === 'multi_choice')?.settings?.options,
    ).toEqual([])

    const textId = store.getState().addBlockAfter(null, 'text')
    store.getState().changeBlockType(textId, 'dropdown')
    expect(store.getState().blocks.find((b) => b.id === textId)?.settings?.options).toEqual([])
  })

  it('addOption с текстом рождает готовый вариант (первый символ в призраке)', () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    const id = store.getState().blocks[0]!.id

    const newId = store.getState().addOption(id, 'С')

    const opts = store.getState().blocks[0]!.settings!.options!
    expect(opts).toHaveLength(1)
    expect(opts[0]).toMatchObject({ id: newId, label: 'С' })
  })

  it('addOptionAfter вставляет вариант сразу после текущего и возвращает id (Д5)', () => {
    const store = createBuilderStore()
    // Приезжает вопросом (подпись + поле): голого choice не бывает.
    store.getState().addFieldAfter(null, 'single_choice')
    const choice = () => store.getState().blocks.find((b) => b.type === 'single_choice')!
    const blockId = choice().id
    const first = store.getState().addOption(blockId)
    store.getState().addOption(blockId) // теперь [first, second]
    const second = choice().settings!.options![1]!.id
    store.getState().markSaved()

    // Enter на ПЕРВОМ варианте → новый ложится между first и second, а не в конец.
    const newId = store.getState().addOptionAfter(blockId, first)

    const opts = choice().settings!.options!
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
    store.getState().updateBlock(titleId, { text: textFromString('Имя') })

    const focus = store.getState().undo() // откат правки текста подписи
    expect(focus).toBe(titleId)
    expect(plainText(store.getState().blocks[0]?.text)).toBe('')
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

describe('createBuilderStore — ряды из двух вопросов (фаза 13.6)', () => {
  // Полотно из голых полей: каждое — своя группа.
  const fields = (
    ...types: ('short_text' | 'email' | 'phone' | 'long_text' | 'single_choice' | 'dropdown')[]
  ) => {
    const store = createBuilderStore()
    for (const t of types) store.getState().addBlock(t)
    return store
  }
  // Хранимый бит колонки — по блокам потока. С канона секции (§11.4) участник ЛЕВОЙ
  // колонки помечен ЯВНО ('left'), а не отсутствием ключа: без этого левая колонка
  // ломалась бы на втором элементе — первый закрывал бы секцию и уезжал из неё.
  const cols = (store: ReturnType<typeof createBuilderStore>) =>
    store.getState().blocks.map((b) => b.settings?.column ?? '-')
  // Ряды, которые из этих битов выведет рендер: стор и полотно обязаны совпадать
  // (расхождение «помечен — нарисован иначе» и было дефектом первой реализации).
  // Число КОЛОНОК в каждом ряду. Размер стопки внутри колонки — отдельным помощником
  // ниже: большинству тестов важно «ряд собран / не собран», а не глубина стопки.
  const rows = (store: ReturnType<typeof createBuilderStore>) =>
    packRows(groupBlocks(store.getState().blocks)).map((row) => row.length)
  // Ряды колонками: [['a'], ['b', 'c']] — во втором ряду правая колонка из двух.
  const cells = (store: ReturnType<typeof createBuilderStore>) =>
    packRows(groupBlocks(store.getState().blocks)).map((row) => row.map((cell) => cell.length))

  // Ряд из двух полей: второе уезжает в правую ячейку первого.
  const paired = (...types: ('short_text' | 'email' | 'phone' | 'long_text')[]) => {
    const store = fields(...types)
    const [a, b] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 2, true)
    return store
  }

  it('placeInRow ставит бит правому и остаётся одним шагом undo', () => {
    const store = paired('short_text', 'email')
    expect(cols(store)).toEqual([1, 2])
    expect(rows(store)).toEqual([2])

    store.getState().undo()
    expect(cols(store)).toEqual(['-', '-'])
    expect(rows(store)).toEqual([1, 1])

    store.getState().redo()
    expect(cols(store)).toEqual([1, 2])
  })

  it('placeInRow переносит группу вплотную за цель (жест через блок)', () => {
    const store = fields('short_text', 'long_text', 'email')
    const [a, , c] = store.getState().blocks
    store.getState().placeInRow(c!.groupId, a!.groupId, 2, true)

    const s = store.getState()
    expect(s.blocks.map((b) => b.type)).toEqual(['short_text', 'email', 'long_text'])
    expect(cols(store)).toEqual([1, 2, '-'])
  })

  // Условий отказа осталось два, и оба про РАСКЛАДКУ, а не про тип: ячейка цели
  // занята и цель занимает всю ширину (в ней собран внутренний ряд). Прежнее «цель
  // не из whitelist» снято вместе с whitelist'ом.
  // Отказов осталось два, и оба про РАСКЛАДКУ: цель занимает всю ширину (в ней собран
  // внутренний ряд) и «слева» на элементе правой стопки. «Ячейка занята» отказом быть
  // перестало — правая колонка это стопка (решение владельца 2026-07-29).
  it('цель во всю ширину — no-op, история и dirty целы', () => {
    const store = fields('short_text', 'email', 'phone')
    const [, , c] = store.getState().blocks
    // Вопрос с ВНУТРЕННИМ рядом: такая группа занимает всю ширину (§6.5).
    store.getState().addQuestionAfter(c!.id, 'short_text')
    const [wideCaption, wideField] = store.getState().blocks.slice(-2)
    store.getState().placeBlockInRow(wideField!.id, wideCaption!.id)
    const order = store.getState().blocks.map((b) => b.id)
    store.getState().markSaved()

    store.getState().placeInRow(c!.groupId, wideCaption!.groupId, 2, true)
    const s = store.getState()
    expect(s.dirty).toBe(false)
    expect(s.blocks.map((b) => b.id)).toEqual(order)
  })

  // side — это КОЛОНКА, В КОТОРУЮ ВСТАЁТ АКТИВНЫЙ, а не «с какой стороны от цели». От
  // любого участника секции можно добавить и в левую колонку, и в правую: у цели сосед
  // по колонке уже есть, вопрос лишь в какую колонку добавить.
  it('от участника секции можно добавить в ЛЮБУЮ колонку', () => {
    const store = fields('short_text', 'email', 'phone', 'long_text')
    const [a, b, c, d] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 2, true) // секция [a | b], c и d ниже
    expect(cells(store)).toEqual([[1, 1], [1], [1]])

    // Целимся в b (он во ВТОРОЙ колонке), просим первую — c уходит в её стопку.
    store.getState().placeInRow(c!.groupId, b!.groupId, 1, false)
    expect(cells(store)).toEqual([[2, 1], [1]])
    // Целимся в a (он в ПЕРВОЙ колонке), просим вторую — d уходит в её стопку.
    store.getState().placeInRow(d!.groupId, a!.groupId, 2, false)
    expect(cells(store)).toEqual([[2, 2]])
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  // То, ради чего этап и делается: слева картинка, справа несколько блоков.
  it('несколько блоков в одну колонку — по одному, целясь в любого участника', () => {
    const store = createBuilderStore()
    store.getState().addBlock('image')
    for (const t of ['text', 'short_text', 'email'] as const) store.getState().addBlock(t)
    const [img, t1, t2, t3] = store.getState().blocks

    store.getState().placeInRow(t1!.groupId, img!.groupId, 2, true)
    store.getState().placeInRow(t2!.groupId, img!.groupId, 2, false)
    store.getState().placeInRow(t3!.groupId, img!.groupId, 2, false)
    // Одна секция: слева картинка, справа стопка из трёх.
    expect(cells(store)).toEqual([[1, 3]])
    expect(store.getState().blocks.map((b) => b.type)).toEqual([
      'image',
      'text',
      'short_text',
      'email',
    ])
  })

  // То, ради чего стопка и появилась: слева длинный ответ, справа несколько коротких.
  it('несколько блоков в правой колонке: третий встаёт под вторым', () => {
    const store = fields('long_text', 'short_text', 'email', 'phone')
    const [a, b, c, d] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 2, true)
    store.getState().placeInRow(c!.groupId, b!.groupId, 2, false)
    store.getState().placeInRow(d!.groupId, c!.groupId, 2, false)
    expect(cells(store)).toEqual([[1, 3]])
    expect(store.getState().blocks.map((x) => x.type)).toEqual([
      'long_text',
      'short_text',
      'email',
      'phone',
    ])
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  // Перестановка ВНУТРИ ряда ряд не разваливает: состав участников тот же, нового ряда
  // не собралось. Без этого исключения стопка была бы бессмысленной — Alt+Shift+↑↓ на
  // её элементе сносил бы весь ряд.
  it('перестановка внутри стопки ряд сохраняет', () => {
    const store = fields('long_text', 'short_text', 'email')
    const [a, b, c] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 2, true)
    store.getState().placeInRow(c!.groupId, b!.groupId, 2, false)
    expect(cells(store)).toEqual([[1, 2]])

    store.getState().moveGroup(c!.id, 'up')
    expect(store.getState().blocks.map((x) => x.type)).toEqual(['long_text', 'email', 'short_text'])
    expect(cells(store)).toEqual([[1, 2]])
  })

  // А защита от приклеивания к ПОСТОРОННЕМУ вопросу цела: там прежний сосед в новом
  // ряду не остаётся, и бит снимается, как и до появления стопок.
  it('переезд участника ряда к чужому вопросу бит снимает', () => {
    const store = fields('short_text', 'email', 'phone')
    const [, b, c] = store.getState().blocks
    store.getState().placeInRow(c!.groupId, b!.groupId, 2, true) // ряд [b | c], первый сам по себе
    expect(cells(store)).toEqual([[1], [1, 1]])

    // c уезжает вверх, к a: прежнего соседа (b) в его новом ряду нет.
    store.getState().moveGroup(c!.id, 'up')
    store.getState().moveGroup(c!.id, 'up')
    expect(store.getState().blocks.map((x) => x.type)).toEqual(['phone', 'short_text', 'email'])
    expect(cols(store)).toEqual(['-', '-', '-'])
  })

  // ---- Ряд с обеих сторон и любым элементом (решение владельца 2026-07-29) ----

  it('placeInRow слева ставит активного ПЕРЕД целью, а бит отдаёт цели', () => {
    const store = fields('short_text', 'email')
    const [a, b] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 1, true)
    expect(store.getState().blocks.map((x) => x.type)).toEqual(['email', 'short_text'])
    // Бит всегда у ПРАВОГО участника — им стала цель, а не переехавший.
    expect(cols(store)).toEqual([1, 2])
    expect(rows(store)).toEqual([2])
  })

  it('переезд слева забирает у активного его прежний бит', () => {
    const store = fields('short_text', 'email', 'phone')
    const [a, b, c] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 2, true) // ряд [a, b]
    store.getState().placeInRow(b!.groupId, c!.groupId, 1, true) // b уезжает влево от c
    expect(store.getState().blocks.map((x) => x.type)).toEqual(['short_text', 'email', 'phone'])
    // Иначе b утянул бы в ряд ещё и a: бит остался бы на нём вторым. Заодно видно, что
    // a свою метку левой колонки ОТДАЛ: секция, из которой ушёл единственный правый,
    // перестала существовать, и бит стал инертным.
    expect(cols(store)).toEqual(['-', 1, 2])
    expect(rows(store)).toEqual([1, 2])
  })

  it('одинокий лэйаут-блок встаёт в ряд с вопросом', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('text')
    const [field, text] = store.getState().blocks
    store.getState().placeInRow(text!.groupId, field!.groupId, 2, true)
    expect(cols(store)).toEqual([1, 2])
    expect(rows(store)).toEqual([2])
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  // Лэйаут-блок СЛЕВА: у его группы нет отвечаемого блока, и пока «личность группы»
  // искалась только среди отвечаемых, ссылка на соседа не записывалась — стор считал
  // бит партнёра инертным и снимал его на первой же структурной правке (найдено при
  // разборе стопок, 2026-07-29).
  it('лэйаут-блок слева в ряду переживает структурную правку', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text')
    store.getState().addBlock('short_text')
    const [text, field] = store.getState().blocks
    store.getState().placeInRow(field!.groupId, text!.groupId, 2, true)
    expect(rows(store)).toEqual([2])

    // Любая структурная правка гоняет normalizeColumns с prev — ряд обязан выжить.
    store.getState().addBlock('email')
    expect(rows(store)).toEqual([2, 1])
    expect(cols(store)).toEqual([1, 2, '-'])
  })

  // ---- Вставка «ниже» из секции (§11.6) ----

  // Отчёт владельца 2026-07-29: «перенесли блок в ряд (левый), потом через Enter начали
  // писать — структура разваливается, между элементами появляется текстовое поле».
  // Причина: Enter вставлял блок после ГРУППЫ, а не после СЕКЦИИ, и полноширинный
  // новичок (бита у него нет) резал секцию пополам.
  it('Enter из колонки создаёт строку ПОСЛЕ секции, а не между колонками', () => {
    const store = fields('short_text', 'email')
    const [a, b] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 2, true)
    expect(cells(store)).toEqual([[1, 1]])

    // Enter зовёт addBlockAfterGroup с активной строкой — из ЛЕВОЙ колонки.
    store.getState().addBlockAfterGroup(a!.id, 'text')
    expect(store.getState().blocks.map((x) => x.type)).toEqual(['short_text', 'email', 'text'])
    // Секция цела, новичок — полноширинный ряд под ней.
    expect(cells(store)).toEqual([[1, 1], [1]])
    expect(cols(store)).toEqual([1, 2, '-'])
  })

  it('Enter из ПРАВОЙ колонки — то же место: после всей секции', () => {
    const store = fields('short_text', 'email', 'phone')
    const [a, b, c] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 2, true)
    store.getState().placeInRow(c!.groupId, b!.groupId, 2, false) // стопка справа
    expect(cells(store)).toEqual([[1, 2]])

    store.getState().addBlockAfterGroup(b!.id, 'text')
    expect(store.getState().blocks.map((x) => x.type)).toEqual([
      'short_text',
      'email',
      'phone',
      'text',
    ])
    expect(cells(store)).toEqual([[1, 2], [1]])
  })

  it('вопрос-бандл из колонки тоже уходит под секцию', () => {
    const store = fields('short_text', 'email')
    const [a, b] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 2, true)

    store.getState().addQuestionAfter(a!.id, 'phone')
    expect(store.getState().blocks.map((x) => x.type)).toEqual([
      'short_text',
      'email',
      'title',
      'phone',
    ])
    // Бандл — ОДНА группа, поэтому второй ряд об одной ячейке.
    expect(cells(store)).toEqual([[1, 1], [1]])
  })

  // ---- Канон и уборка секции (§11.4–11.5) ----

  it('канон: левая колонка помечена явно и порядок внутри секции колоночный', () => {
    const store = createBuilderStore()
    const schema = formSchemaSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      // Неявная форма плюс перемешанный порядок — так выглядит документ, собранный до
      // этапа и правленный руками. Канон обязан привести его к явной форме.
      blocks: [
        { id: 'l1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 'r1', groupId: 'g2', type: 'email', settings: { column: 2 } },
        { id: 'l2', groupId: 'g3', type: 'phone', settings: { column: 1 } },
      ],
    } satisfies FormSchema)
    store.getState().hydrate(schema)
    // l2 стоял ПОСЛЕ правого — по §11.3 это начало новой секции, и она без пары:
    // бит инертен, элемент во всю ширину.
    expect(store.getState().blocks.map((b) => b.id)).toEqual(['l1', 'r1', 'l2'])
    expect(cols(store)).toEqual([1, 2, '-'])
  })

  it('канон идемпотентен: повторная правка документ не двигает', () => {
    const store = fields('short_text', 'email', 'phone')
    const [a, b] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 2, true)
    const once = JSON.stringify(store.getState().toSchema())
    store.getState().updateBlock(a!.id, { required: true })
    store.getState().updateBlock(a!.id, { required: false })
    expect(JSON.stringify(store.getState().toSchema())).toBe(once)
  })

  it('полноширинный блок в середине секции разрывает её, а нижняя часть теряет биты', () => {
    const store = fields('short_text', 'email')
    const [a, b] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 2, true)
    expect(cols(store)).toEqual([1, 2])

    // Между участниками появляется абзац: у b от прежней компании (a) не остаётся
    // никого — он оказался в секции с новичком, и бит снимается.
    store.getState().addBlockAfter(a!.id, 'text')
    expect(store.getState().blocks.map((x) => x.type)).toEqual(['short_text', 'text', 'email'])
    expect(cols(store)).toEqual(['-', '-', '-'])
  })

  it('takeOwnRow возвращает правого своим рядом', () => {
    const store = paired('short_text', 'email')
    store.getState().takeOwnRow(store.getState().blocks[1]!.id)
    expect(cols(store)).toEqual(['-', '-'])
    expect(rows(store)).toEqual([1, 1])
  })

  it('удаление левого: бит правого снят, полряда не остаётся', () => {
    const store = paired('short_text', 'email')
    store.getState().removeGroup(store.getState().blocks[0]!.id)
    expect(cols(store)).toEqual(['-'])
    expect(rows(store)).toEqual([1])
  })

  // Whitelist коротких контролов отменён (решение владельца 2026-07-29, ADR §10):
  // смена типа на длинный ответ ряд больше не разваливает — что читается в половину
  // колонки, решает автор формы. Раньше это были два отдельных теста, по одному на
  // каждого участника.
  it('смена типа участника ряд не рвёт — ни слева, ни справа', () => {
    const store = paired('short_text', 'email')
    const [a, b] = store.getState().blocks

    store.getState().changeBlockType(a!.id, 'long_text')
    expect(cols(store)).toEqual([1, 2])
    expect(rows(store)).toEqual([2])

    store.getState().changeBlockType(b!.id, 'scale')
    expect(cols(store)).toEqual([1, 2])
    expect(rows(store)).toEqual([2])
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  it('перенос левого вниз рвёт ряд (правый становится первым — бит инертен)', () => {
    const store = paired('short_text', 'email', 'long_text')
    store.getState().moveGroup(store.getState().blocks[0]!.id, 'down')
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['email', 'short_text', 'long_text'])
    expect(cols(store)).toEqual(['-', '-', '-'])
    expect(rows(store)).toEqual([1, 1, 1])
  })

  // Сосед у бита — КОНКРЕТНЫЙ: «встань в ряд с этим вопросом», а не «с кем угодно
  // сверху». Сосед в этих трёх тестах whitelist-типа, поэтому инертность бит не
  // снимет — снимает его именно правило подмены соседа.
  it('перенос правого вниз снимает бит, а не приклеивает к новому соседу', () => {
    const store = paired('short_text', 'email', 'phone')
    store.getState().moveGroup(store.getState().blocks[1]!.id, 'down')
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['short_text', 'phone', 'email'])
    expect(cols(store)).toEqual(['-', '-', '-'])
    expect(rows(store)).toEqual([1, 1, 1])
  })

  it('дроп группы на правого участника не собирает ряд молча', () => {
    const store = paired('short_text', 'email', 'phone')
    const [left, , c] = store.getState().blocks
    store.getState().reorderGroups(c!.groupId, left!.groupId)
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['short_text', 'phone', 'email'])
    expect(rows(store)).toEqual([1, 1, 1])
  })

  it('вставка контентного блока между участниками ряда рвёт ряд', () => {
    const store = paired('short_text', 'email')
    store.getState().addBlockAfter(store.getState().blocks[0]!.id, 'heading')
    expect(rows(store)).toEqual([1, 1, 1])
    expect(cols(store)).toEqual(['-', '-', '-'])
  })

  it('вставка короткого поля между участниками рвёт ряд, а не отдаёт ячейку новичку', () => {
    const store = paired('short_text', 'email')
    store.getState().addBlockAfter(store.getState().blocks[0]!.id, 'phone')
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['short_text', 'phone', 'email'])
    expect(rows(store)).toEqual([1, 1, 1])
  })

  it('перенос из одного ряда в свободную ячейку другого — не no-op', () => {
    const store = fields('short_text', 'email', 'phone')
    const [a, b, c] = store.getState().blocks
    store.getState().placeInRow(b!.groupId, a!.groupId, 2, true) // ряд [a, b], c один
    store.getState().placeInRow(b!.groupId, c!.groupId, 2, true) // b переезжает к c
    expect(store.getState().blocks.map((x) => x.type)).toEqual(['short_text', 'phone', 'email'])
    expect(rows(store)).toEqual([1, 2])
  })

  it('makeQuestion на правом участнике сохраняет ряд (бит переезжает на новое поле)', () => {
    const store = paired('short_text', 'short_text')
    store.getState().makeQuestion(store.getState().blocks[1]!.id, 'short_text')
    expect(store.getState().blocks.map((b) => b.type)).toEqual([
      'short_text',
      'title',
      'short_text',
    ])
    expect(rows(store)).toEqual([2])
  })

  it('hydrate снимает инертный бит (левого соседа нет)', () => {
    const store = createBuilderStore()
    const schema = formSchemaSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'b1', groupId: 'g_b1', type: 'short_text', settings: { column: 2 } }],
    } satisfies FormSchema)
    store.getState().hydrate(schema)
    expect(store.getState().blocks[0]?.settings).not.toHaveProperty('column')
    expect(store.getState().dirty).toBe(false)
  })

  it('toSchema после переноса в ряд проходит валидацию контракта', () => {
    const store = paired('short_text', 'email')
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  // ---- v4: носитель бита — первый блок группы (§6.3) ----

  it('placeInRow ставит бит на ГОЛОВУ группы, а не на её отвечаемый блок', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // подпись + поле
    store.getState().addQuestionAfter(store.getState().blocks[1]!.id, 'email')
    const [, , t2] = store.getState().blocks
    store.getState().placeInRow(t2!.groupId, store.getState().blocks[0]!.groupId, 2, true)
    expect(cols(store)).toEqual([1, '-', 2, '-'])
    expect(rows(store)).toEqual([2])
  })

  it('takeOwnRow снимает бит с головы мульти-группы', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text')
    store.getState().addQuestionAfter(store.getState().blocks[1]!.id, 'email')
    const [, , t2, f2] = store.getState().blocks
    store.getState().placeInRow(t2!.groupId, store.getState().blocks[0]!.groupId, 2, true)
    store.getState().takeOwnRow(f2!.id) // зовётся с любой строки вопроса
    expect(cols(store)).toEqual(['-', '-', '-', '-'])
    expect(rows(store)).toEqual([1, 1])
  })

  // Случай, ради которого существует пере-якорение: заголовок, выданный полю,
  // делает его вторым блоком группы — и тот же ключ на нём начал бы значить
  // «встань справа от своей подписи». Ряд обязан пережить правку заголовка.
  it('addCaptionFor правому участнику сохраняет ряд: бит переезжает на подпись', () => {
    const store = paired('short_text', 'email')
    const right = store.getState().blocks[1]!
    store.getState().addCaptionFor(right.id)
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['short_text', 'title', 'email'])
    expect(cols(store)).toEqual([1, 2, '-'])
    expect(rows(store)).toEqual([2])
  })

  it('makeQuestion на правом участнике сохраняет ряд битом на подписи', () => {
    const store = paired('short_text', 'short_text')
    store.getState().makeQuestion(store.getState().blocks[1]!.id, 'short_text')
    expect(cols(store)).toEqual([1, 2, '-'])
    expect(rows(store)).toEqual([2])
  })

  // Инертность второго уровня: бит на не первом блоке — внутригрупповой, и если
  // раскладчик его не применил (пара не «подпись + поле»), стор его снимает — тем же
  // правилом и тем же раскладчиком, что и на уровне групп.
  it('hydrate снимает внутригрупповой бит, который раскладчик не применил', () => {
    const store = createBuilderStore()
    const schema = formSchemaSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 't', groupId: 'g', type: 'title', text: textFromString('Индекс') },
        { id: 'd', groupId: 'g', type: 'text', text: textFromString('шесть цифр') },
        { id: 'f', groupId: 'g', type: 'short_text', settings: { column: 2 } },
      ],
    } satisfies FormSchema)
    store.getState().hydrate(schema)
    expect(cols(store)).toEqual(['-', '-', '-'])
    expect(store.getState().dirty).toBe(false)
  })

  it('hydrate оставляет внутригрупповой бит рабочей пары «подпись + поле»', () => {
    const store = createBuilderStore()
    const schema = formSchemaSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 't', groupId: 'g', type: 'title', text: textFromString('Индекс') },
        { id: 'f', groupId: 'g', type: 'short_text', settings: { column: 2 } },
      ],
    } satisfies FormSchema)
    store.getState().hydrate(schema)
    expect(cols(store)).toEqual(['-', 2])
  })

  // ---- Ряд ВНУТРИ вопроса: команды переноса (§6.6) ----

  // Вопрос: подпись + поле. Ряд собирается на втором уровне и в кросс-групповой не
  // превращается — обёртка ряда групп остаётся пустой.
  const question = (type: 'short_text' | 'long_text' = 'short_text') => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, type)
    return store
  }

  it('placeBlockInRow ставит поле в ряд со своей подписью', () => {
    const store = question()
    const [caption, field] = store.getState().blocks
    store.getState().placeBlockInRow(field!.id, caption!.id)
    expect(cols(store)).toEqual(['-', 2])
    expect(rows(store)).toEqual([1]) // кросс-групповой ряд не появился
  })

  it('placeBlockInRow переносит поле ВПЛОТНУЮ за подпись — контент между ними не рвёт пару', () => {
    const store = question()
    const [caption, field] = store.getState().blocks
    store.getState().addBlockAfter(caption!.id, 'text') // контент между подписью и полем
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['title', 'text', 'short_text'])

    store.getState().placeBlockInRow(field!.id, caption!.id)
    expect(store.getState().blocks.map((b) => b.type)).toEqual(['title', 'short_text', 'text'])
    expect(cols(store)).toEqual(['-', 2, '-'])
  })

  it('длинный ответ встаёт в ряд с подписью наравне с коротким (whitelist отменён)', () => {
    const store = question('long_text')
    const [caption, field] = store.getState().blocks
    store.getState().placeBlockInRow(field!.id, caption!.id)
    expect(cols(store)).toEqual(['-', 2])
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  it('ячейка подписи занята — второй блок в тот же ряд не лезет', () => {
    const store = question()
    const [caption, field] = store.getState().blocks
    store.getState().placeBlockInRow(field!.id, caption!.id)
    const extra = store.getState().addBlockAfter(field!.id, 'text')
    store.getState().markSaved()

    store.getState().placeBlockInRow(extra, caption!.id)
    expect(store.getState().dirty).toBe(false)
  })

  it('takeOwnRow на поле в ряду разбирает ряд ВНУТРИ вопроса, а не уводит вопрос', () => {
    const store = question()
    const [caption, field] = store.getState().blocks
    store.getState().placeBlockInRow(field!.id, caption!.id)
    store.getState().takeOwnRow(field!.id)
    expect(cols(store)).toEqual(['-', '-'])

    // Тот же вызов с подписи (головы группы) — команда уровня вопроса, и снимать ей
    // нечего: вопрос и так стоит своим рядом.
    store.getState().markSaved()
    store.getState().takeOwnRow(caption!.id)
    expect(store.getState().dirty).toBe(false)
  })

  it('внутренний ряд переживает toSchema и обратную загрузку', () => {
    const store = question()
    const [caption, field] = store.getState().blocks
    store.getState().placeBlockInRow(field!.id, caption!.id)
    const schema = formSchemaSchema.parse(store.getState().toSchema())

    const other = createBuilderStore()
    other.getState().hydrate(schema)
    expect(other.getState().blocks.map((b) => b.settings?.column ?? '-')).toEqual(['-', 2])
  })
})

describe('createBuilderStore — ось колонок Mod+Alt+←/→ (этап 15.6, §11.6)', () => {
  // Ось одна: полная ширина ↔ левая колонка ↔ правая. Проверяем ОБА направления в каждой
  // позиции и оба края: клавиша, которая делает шаг «в никуда», обязана молчать целиком —
  // без правки, без истории, без dirty.
  const fields = (n: number) => {
    const store = createBuilderStore()
    const types = ['short_text', 'email', 'phone'] as const
    for (let i = 0; i < n; i++) store.getState().addBlock(types[i % 3]!)
    return store
  }
  const cols = (store: ReturnType<typeof createBuilderStore>) =>
    store.getState().blocks.map((b) => b.settings?.column ?? '-')
  const ids = (store: ReturnType<typeof createBuilderStore>) =>
    store.getState().blocks.map((b) => b.id)
  const cells = (store: ReturnType<typeof createBuilderStore>) =>
    packRows(groupBlocks(store.getState().blocks)).map((row) => row.map((cell) => cell.length))

  it('rowPosition называет координату на оси, а не одну из пяти позиций', () => {
    // Колонок стало до MAX_COLUMNS (2026-08-11), и позиция перестала быть перечислением:
    // теперь это номер колонки, число колонок в ряду и «один ли я в своей».
    const store = fields(4)
    const [a, b, c, d] = store.getState().blocks
    // Первый вопрос полотна: вставать в ряд не с кем.
    expect(rowPosition(store.getState().blocks, a!.id)).toEqual({ kind: 'solo' })
    expect(rowPosition(store.getState().blocks, b!.id)).toEqual({ kind: 'enter' })

    store.getState().shiftColumn(b!.id, 'right')
    expect(rowPosition(store.getState().blocks, a!.id)).toEqual({
      kind: 'in',
      col: 1,
      cols: 2,
      alone: true,
    })
    expect(rowPosition(store.getState().blocks, b!.id)).toEqual({
      kind: 'in',
      col: 2,
      cols: 2,
      alone: true,
    })

    // Стопка во второй колонке: alone гаснет, число колонок прежнее.
    store.getState().placeInRow(c!.groupId, b!.groupId, 2, false)
    expect(rowPosition(store.getState().blocks, b!.id)).toEqual({
      kind: 'in',
      col: 2,
      cols: 2,
      alone: false,
    })

    // Третья колонка — та же координата, просто дальше по оси.
    store.getState().placeInRow(d!.groupId, a!.groupId, 3, true)
    expect(rowPosition(store.getState().blocks, d!.id)).toEqual({
      kind: 'in',
      col: 3,
      cols: 3,
      alone: true,
    })
  })

  it('шаг вправо из полной ширины открывает секцию с предыдущим', () => {
    const store = fields(2)
    const [, b] = store.getState().blocks

    store.getState().shiftColumn(b!.id, 'right')

    expect(cols(store)).toEqual([1, 2])
    expect(cells(store)).toEqual([[1, 1]])
  })

  it('шаг влево из полной ширины встаёт в ЛЕВУЮ колонку ряда с предыдущим', () => {
    const store = fields(2)
    const [a, b] = store.getState().blocks

    store.getState().shiftColumn(b!.id, 'left')

    // Клавиша выбирает колонку, а цель у обеих одна — предыдущий вопрос. Встав слева, b
    // оказывается выше a в документе: колоночный порядок канона (§11.4) читается сверху
    // вниз по колонкам, а не по экрану.
    expect(ids(store)).toEqual([b!.id, a!.id])
    expect(cols(store)).toEqual([1, 2])
    expect(cells(store)).toEqual([[1, 1]])
  })

  it('шаг влево из полной ширины ПОД секцией добавляет в её левую колонку', () => {
    const store = fields(3)
    const [a, b, c] = store.getState().blocks
    store.getState().shiftColumn(b!.id, 'right') // секция [a | b], c ниже во всю ширину

    store.getState().shiftColumn(c!.id, 'left')

    // Цель — предыдущая группа (b, правая колонка), но встаём мы в КОНЕЦ левой: колонку
    // выбрала клавиша, а не сторона цели.
    expect(ids(store)).toEqual([a!.id, c!.id, b!.id])
    expect(cols(store)).toEqual([1, 1, 2])
    expect(cells(store)).toEqual([[2, 1]])
  })

  it('первый вопрос полотна — край оси в обе стороны', () => {
    const store = fields(2)
    const first = store.getState().blocks[0]!
    store.getState().markSaved()

    store.getState().shiftColumn(first.id, 'left')
    store.getState().shiftColumn(first.id, 'right')

    expect(store.getState().dirty).toBe(false)
  })

  it('правая колонка — правый край оси: шаг вправо молчит', () => {
    const store = fields(2)
    const [, b] = store.getState().blocks
    store.getState().shiftColumn(b!.id, 'right')
    store.getState().markSaved()

    store.getState().shiftColumn(b!.id, 'right')

    expect(store.getState().dirty).toBe(false)
    expect(cols(store)).toEqual([1, 2])
  })

  it('шаг влево из правой колонки-одиночки выводит из секции: её не остаётся', () => {
    const store = fields(2)
    const [a, b] = store.getState().blocks
    store.getState().shiftColumn(b!.id, 'right')

    store.getState().shiftColumn(b!.id, 'left')

    // Колонка опустела → секции нет вовсе, и бит снят с ОБОИХ: у оставшегося он ничего
    // не значит, а раскладчик молча приклеил бы его к секции ниже.
    expect(cols(store)).toEqual(['-', '-'])
    expect(ids(store)).toEqual([a!.id, b!.id])
  })

  it('шаг влево из стопки справа переводит элемент в левую колонку', () => {
    const store = fields(3)
    const [a, b, c] = store.getState().blocks
    store.getState().shiftColumn(b!.id, 'right')
    store.getState().placeInRow(c!.groupId, b!.groupId, 2, false) // справа стопка [b, c]

    store.getState().shiftColumn(c!.id, 'left')

    // c встаёт в КОНЕЦ левой колонки — туда же, куда его кладёт жест.
    expect(cells(store)).toEqual([[2, 1]])
    expect(ids(store)).toEqual([a!.id, c!.id, b!.id])
    expect(cols(store)).toEqual([1, 1, 2])
  })

  it('шаг вправо из левой колонки-одиночки меняет участников местами', () => {
    const store = fields(2)
    const [a, b] = store.getState().blocks
    store.getState().shiftColumn(b!.id, 'right') // [a | b]

    store.getState().shiftColumn(a!.id, 'right')

    // Слева одна колонка не остаётся пустой, а меняется с правой: a уехал в правую
    // колонку, значит b стал левым. Обмен — следствие канона, а не отдельная команда.
    expect(ids(store)).toEqual([b!.id, a!.id])
    expect(cols(store)).toEqual([1, 2])
    expect(cells(store)).toEqual([[1, 1]])
  })

  it('канон помечает левую колонку явно, даже если в ней лежал чужой бит', () => {
    // Неявная форма приезжает двумя путями: из старой формы (там левый бита не несёт) и из
    // переезда между колонками (там забранный в левую колонку несёт свой прежний 'right').
    // Хранимой ни одна не остаётся: вставка второго элемента в такую левую колонку выгнала
    // бы из секции того, кто её открыл.
    const store = createBuilderStore()
    store.getState().hydrate(
      formSchemaSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        blocks: [
          { id: 'x1', groupId: 'g_x1', type: 'short_text', settings: { column: 2 } },
          { id: 'x2', groupId: 'g_x2', type: 'email', settings: { column: 2 } },
        ],
      }),
    )

    expect(cols(store)).toEqual([1, 2])
    expect(cells(store)).toEqual([[1, 1]])
    // Идемпотентность: канон — неподвижная точка, а не колебание между двумя формами.
    const once = JSON.stringify(store.getState().toSchema())
    const again = createBuilderStore()
    again.getState().hydrate(formSchemaSchema.parse(store.getState().toSchema()))
    expect(JSON.stringify(again.getState().toSchema())).toBe(once)
  })

  it('шаг вправо из левой колонки-одиночки не разваливает стопку справа', () => {
    // Найдено ревью: гашение «сирот» в placeInRow срабатывало и на переезде ВНУТРИ своей
    // же секции (левая колонка пустеет по построению), и вместо переезда команда роняла
    // одного участника стопки во всю ширину, а второго молча переводила в левую колонку.
    const store = fields(3)
    const [a, b, c] = store.getState().blocks
    store.getState().shiftColumn(b!.id, 'right')
    store.getState().placeInRow(c!.groupId, b!.groupId, 2, false) // [a | b, c]

    store.getState().shiftColumn(a!.id, 'right')

    // a был в колонке ОДИН, значит колонка едет вместе с ним и меняется со стопкой
    // местами: стопка целая, a справа от неё. Прежде (пока колонок было две) он вливался
    // в стопку, колонка исчезала, а первый из стопки молча переезжал в левую — три
    // элемента в одной колонке иначе не помещались. С 2026-08-11 помещаются, и молчаливый
    // переезд соседа перестал быть нужен: шаг двигает только того, кого просили.
    expect(ids(store)).toEqual([b!.id, c!.id, a!.id])
    expect(cols(store)).toEqual([1, 1, 2])
    expect(cells(store)).toEqual([[2, 1]])
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  it('шаг влево из левой колонки со стопкой уводит вопрос ПОД секцию', () => {
    const store = fields(3)
    const [a, b, c] = store.getState().blocks
    store.getState().shiftColumn(b!.id, 'right')
    store.getState().placeInRow(c!.groupId, a!.groupId, 1, false) // слева стопка [a, c]

    store.getState().shiftColumn(a!.id, 'left')

    // Полноширинный блок в СЕРЕДИНЕ секции разрезал бы её пополам, поэтому вышедший
    // уезжает под неё — туда же, куда Enter из колонки кладёт новую строку.
    expect(ids(store)).toEqual([c!.id, b!.id, a!.id])
    expect(cols(store)).toEqual([1, 2, '-'])
    expect(cells(store)).toEqual([[1, 1], [1]])
  })

  it('вопрос с внутренним рядом в секцию не встаёт: шага вправо у него нет', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addQuestionAfter(store.getState().blocks[0]!.id, 'email')
    const [, caption, field] = store.getState().blocks
    store.getState().placeBlockInRow(field!.id, caption!.id) // ряд ВНУТРИ вопроса
    store.getState().markSaved()

    expect(rowPosition(store.getState().blocks, caption!.id)).toEqual({ kind: 'solo' })
    store.getState().shiftColumn(caption!.id, 'right')
    expect(store.getState().dirty).toBe(false)
  })
})

describe('createBuilderStore — ряды вариантов (фаза 13.6, §5.1)', () => {
  // Блок рождается с пустым списком: варианты в нём — только настоящие, набранные
  // автором (место для набора даёт «призрак», которого в схеме нет).
  const choiceWith = (...labels: string[]) => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    const id = store.getState().blocks[0]!.id
    for (const label of labels) store.getState().addOption(id, label)
    return { store, id }
  }
  const options = (store: ReturnType<typeof createBuilderStore>) =>
    store.getState().blocks[0]!.settings!.options!
  // Ряд печатаем колонками; стопку в колонке — через «+» (см. groups.test.ts).
  const optRows = (store: ReturnType<typeof createBuilderStore>) =>
    packOptionRows(options(store)).map((row) =>
      row.map((cell) => cell.map((o) => o.label).join('+')),
    )

  it('placeOptionInRow — тот же бит и та же упаковка, что у вопросов', () => {
    const { store, id } = choiceWith('a', 'b', 'c')
    const [, b] = options(store)
    store.getState().placeOptionInRow(id, b!.id, options(store)[0]!.id)
    expect(optRows(store)).toEqual([['a', 'b'], ['c']])

    store.getState().undo()
    expect(optRows(store)).toEqual([['a'], ['b'], ['c']])
  })

  it('placeOptionInRow переносит вариант вплотную за цель', () => {
    const { store, id } = choiceWith('a', 'b', 'c')
    const [a, , c] = options(store)
    store.getState().placeOptionInRow(id, c!.id, a!.id)
    expect(optRows(store)).toEqual([['a', 'c'], ['b']])
  })

  it('ряд цели упёрся в потолок колонок — no-op без dirty', () => {
    // Колонок у вариантов столько же, сколько у вопросов (2026-08-11): жест добавляет
    // СЛЕДУЮЩУЮ колонку, пока они не кончились, и молчит на потолке.
    const labels = Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `o${i + 1}`)
    const { store, id } = choiceWith(...labels)
    const first = options(store)[0]!.id
    for (const o of options(store).slice(1, MAX_COLUMNS)) {
      store.getState().placeOptionInRow(id, o.id, first)
    }
    expect(optRows(store)).toEqual([labels.slice(0, MAX_COLUMNS), [labels[MAX_COLUMNS]!]])
    store.getState().markSaved()

    // Ряд полон: лишний вариант в него не встаёт и историю не трогает.
    store.getState().placeOptionInRow(id, options(store)[MAX_COLUMNS]!.id, first)
    expect(store.getState().dirty).toBe(false)
    expect(optRows(store)).toEqual([labels.slice(0, MAX_COLUMNS), [labels[MAX_COLUMNS]!]])
  })

  it('takeOptionOwnRow возвращает вариант своим рядом', () => {
    const { store, id } = choiceWith('a', 'b')
    store.getState().placeOptionInRow(id, options(store)[1]!.id, options(store)[0]!.id)
    store.getState().takeOptionOwnRow(id, options(store)[1]!.id)
    expect(optRows(store)).toEqual([['a'], ['b']])
  })

  it('удаление левого варианта снимает бит правого', () => {
    const { store, id } = choiceWith('a', 'b')
    store.getState().placeOptionInRow(id, options(store)[1]!.id, options(store)[0]!.id)
    store.getState().removeOption(id, options(store)[0]!.id)
    expect(options(store)[0]).not.toHaveProperty('column')
    expect(optRows(store)).toEqual([['b']])
  })

  it('вариант, уехавший наверх Alt+↑, теряет бит', () => {
    const { store, id } = choiceWith('a', 'b')
    store.getState().placeOptionInRow(id, options(store)[1]!.id, options(store)[0]!.id)
    store.getState().moveOption(id, options(store)[1]!.id, 'up')
    expect(optRows(store)).toEqual([['b'], ['a']])
  })

  it('вариант, уехавший вниз, не приклеивается к новому соседу', () => {
    const { store, id } = choiceWith('a', 'b', 'c')
    store.getState().placeOptionInRow(id, options(store)[1]!.id, options(store)[0]!.id)
    expect(optRows(store)).toEqual([['a', 'b'], ['c']])
    // b уезжает под c: бит держался за a, значит снимается — иначе b встал бы в ряд с c.
    store.getState().moveOption(id, options(store)[1]!.id, 'down')
    expect(optRows(store)).toEqual([['a'], ['c'], ['b']])
  })

  it('перестановка dnd не собирает ряд молча (сосед сменился — бит снят)', () => {
    const { store, id } = choiceWith('a', 'b', 'c')
    const [a, b, c] = options(store)
    store.getState().placeOptionInRow(id, b!.id, a!.id) // ряд [a, b]
    store.getState().reorderOptions(id, c!.id, b!.id) // c встаёт на место b
    expect(optRows(store)).toEqual([['a'], ['c'], ['b']])
  })
})

describe('createBuilderStore — reorderOptions (dnd вариантов, фаза 13.6)', () => {
  const choiceWith3 = () => {
    const store = createBuilderStore()
    store.getState().addBlock('single_choice')
    const id = store.getState().blocks[0]!.id
    for (const label of ['a', 'b', 'c']) store.getState().addOption(id, label)
    return { store, id }
  }
  const labels = (store: ReturnType<typeof createBuilderStore>) =>
    store.getState().blocks[0]!.settings!.options!.map((o) => o.label)

  it('переносит вариант на позицию цели (сплайс, как reorderBlocks)', () => {
    const { store, id } = choiceWith3()
    const [a, , c] = store.getState().blocks[0]!.settings!.options!
    store.getState().reorderOptions(id, a!.id, c!.id)
    expect(labels(store)).toEqual(['b', 'c', 'a'])
  })

  it('незнакомый id и дроп на себя — no-op без dirty', () => {
    const { store, id } = choiceWith3()
    const a = store.getState().blocks[0]!.settings!.options![0]!
    store.getState().markSaved()
    store.getState().reorderOptions(id, a.id, a.id)
    store.getState().reorderOptions(id, 'нет-такого', a.id)
    expect(store.getState().dirty).toBe(false)
    expect(labels(store)).toEqual(['a', 'b', 'c'])
  })
})

// Правило «поле не живёт без подписи» (решение владельца 2026-07-26, предикат
// requiresCaption): choice и шкала приезжают с заголовком, а блок без вариантов не
// существует вовсе. Правило держит стор — в Zod и Go зеркала нет намеренно
// (кросс-блочное условие там ловило бы 422 на undo, как у бита ряда §5).
//
// С фазы 15 это правило ВСТАВКИ и только оно (§4.4 спеки): переносом голую строку
// выбора получить можно, и она законна — редактор показывает ей «Добавьте заголовок»
// вместо сопротивления.
// addCaptionFor (фаза 15, §4.4) — обратный жест к «подсадить поле к ждущей подписи»:
// голой строке ответа дают заголовок, и вопрос собирается с другого конца. Зовут его
// клавиша строки (Mod+Alt+T) и клик по чипу — оба через эту команду.
describe('createBuilderStore — addCaptionFor', () => {
  it('ставит пустую подпись НАД полем и склеивает их в вопрос', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text') // абзац выше — в вопрос попасть не должен
    store.getState().addBlock('email')
    const [para, field] = store.getState().blocks

    const id = store.getState().addCaptionFor(field!.id)

    const b = store.getState().blocks
    expect(b.map((x) => x.type)).toEqual(['text', 'title', 'email'])
    expect(b[1]!.id).toBe(id)
    expect(b[1]!.groupId).toBe(b[2]!.groupId) // подпись + поле = вопрос
    expect(b[0]!.groupId).not.toBe(b[1]!.groupId) // абзац остался одиночкой
    expect(plainText(b[1]!.text)).toBe('') // текст пишет автор, не команда
    expect(para!.id).toBe(b[0]!.id)
  })

  it('на строке с подписью — no-op без шага истории', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text')
    const before = store.getState().blocks
    const past = store.getState().past.length

    expect(store.getState().addCaptionFor(before[1]!.id)).toBeNull()

    // Ни блока, ни шага истории: иначе Ctrl+Z съел бы нажатие, которое ничего не
    // сделало (тот же закон, что у границы moveBlock).
    expect(store.getState().blocks).toBe(before)
    expect(store.getState().past.length).toBe(past)
  })

  it('согласию и контенту заголовок не даётся — свой текст у них уже есть', () => {
    const store = createBuilderStore()
    store.getState().addBlock('consent')
    store.getState().addBlock('text')
    const [consent, text] = store.getState().blocks

    const before = store.getState().blocks
    const past = store.getState().past.length

    expect(store.getState().addCaptionFor(consent!.id)).toBeNull()
    expect(store.getState().addCaptionFor(text!.id)).toBeNull()
    expect(store.getState().addCaptionFor('нет-такого')).toBeNull()

    expect(store.getState().blocks).toBe(before)
    expect(store.getState().past.length).toBe(past)
  })
})

describe('createBuilderStore — тип с обязательным заголовком вставляется вопросом', () => {
  const types = (store: ReturnType<typeof createBuilderStore>) =>
    store.getState().blocks.map((b) => b.type)

  it('перенос оставляет голую строку выбора — правило вставки её не воскрешает', () => {
    const store = createBuilderStore()
    store.getState().addFieldAfter(null, 'single_choice') // [title, single_choice]
    const choiceId = store.getState().blocks[1]!.id

    store.getState().moveBlock(choiceId, 'up') // строка ответа уехала выше подписи

    expect(types(store)).toEqual(['single_choice', 'title'])
    // Ни второго заголовка, ни отката: голое поле выбора — законное состояние
    // документа, а не то, что стор чинит за автора. Вопрос распался — подпись
    // осталась одиночкой в своей группе.
    const [bare, orphan] = store.getState().blocks
    expect(bare!.groupId).not.toBe(orphan!.groupId)
  })

  it('addFieldAfter: в пустое место тип приезжает со своим заголовком, каретка на него', () => {
    const store = createBuilderStore()
    const focus = store.getState().addFieldAfter(null, 'single_choice')

    expect(types(store)).toEqual(['title', 'single_choice'])
    const [title, field] = store.getState().blocks
    expect(focus).toBe(title!.id) // каретка на заголовок, как у addQuestionAfter
    expect(title!.groupId).toBe(field!.groupId) // одна группа, а не две
  })

  it('addFieldAfter: под ждущей подписью поле входит в её группу, второго заголовка нет', () => {
    const store = createBuilderStore()
    store.getState().addBlock('title')
    const titleId = store.getState().blocks[0]!.id
    store.getState().updateBlock(titleId, { text: textFromString('Откуда узнали?') })

    const focus = store.getState().addFieldAfter(titleId, 'multi_choice')

    expect(types(store)).toEqual(['title', 'multi_choice'])
    const [title, field] = store.getState().blocks
    expect(plainText(title!.text)).toBe('Откуда узнали?') // текст заголовка цел
    expect(focus).toBe(field!.id) // каретка на само поле — заголовок уже написан
    expect(title!.groupId).toBe(field!.groupId)
  })

  it('makeField на одинокой подписи: поле под ней, текст не роняется', () => {
    const store = createBuilderStore()
    store.getState().addBlock('label')
    const labelId = store.getState().blocks[0]!.id
    store.getState().updateBlock(labelId, { text: textFromString('Город') })

    // Тип без обязательного заголовка идёт тем же путём: конверсия на месте
    // уронила бы текст подписи, а «Отдельные поля» существуют ровно ради того,
    // чтобы подсадить ответ к одинокому заголовку.
    store.getState().makeField(labelId, 'email')

    expect(types(store)).toEqual(['label', 'email'])
    expect(plainText(store.getState().blocks[0]!.text)).toBe('Город')
    expect(store.getState().blocks[0]!.groupId).toBe(store.getState().blocks[1]!.groupId)
  })

  it('makeField на одиночном абзаце: choice-тип вырождается в вопрос', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text')
    const loneId = store.getState().blocks[0]!.id
    store.getState().updateBlock(loneId, { text: textFromString('Откуда узнали?') })

    const focus = store.getState().makeField(loneId, 'single_choice')

    // Абзац стал подписью (текст сохранён), поле встало под ним — это makeQuestion.
    expect(types(store)).toEqual(['title', 'single_choice'])
    expect(plainText(store.getState().blocks[0]!.text)).toBe('Откуда узнали?')
    expect(focus).toBe(loneId)
  })

  it('makeQuestion на подписи не превращает label в title', () => {
    const store = createBuilderStore()
    store.getState().addBlock('label')
    const labelId = store.getState().blocks[0]!.id

    store.getState().makeQuestion(labelId, 'short_text')

    expect(types(store)).toEqual(['label', 'short_text'])
  })

  it('удаление последнего варианта уносит блок — остаётся голая подпись', () => {
    const store = createBuilderStore()
    store.getState().addFieldAfter(null, 'single_choice') // [title, single_choice]
    const titleId = store.getState().blocks[0]!.id
    store.getState().updateBlock(titleId, { text: textFromString('Откуда узнали?') })
    const choiceId = store.getState().blocks[1]!.id
    const only = store.getState().addOption(choiceId, 'Соцсети')

    store.getState().removeOption(choiceId, only)

    expect(types(store)).toEqual(['title'])
    expect(plainText(store.getState().blocks[0]!.text)).toBe('Откуда узнали?')
  })

  it('удаление последнего варианта — ОДИН шаг истории (undo возвращает вопрос целиком)', () => {
    const store = createBuilderStore()
    store.getState().addFieldAfter(null, 'multi_choice')
    const choiceId = store.getState().blocks[1]!.id
    const only = store.getState().addOption(choiceId, 'Соцсети')

    store.getState().removeOption(choiceId, only)
    store.getState().undo()

    expect(types(store)).toEqual(['title', 'multi_choice'])
    expect(store.getState().blocks[1]!.settings!.options).toHaveLength(1)
  })

  it('вопрос, потерявший поле, ряд НЕ разваливает: осиротевшая подпись — участник', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text')
    const left = store.getState().blocks[1]!
    store.getState().addFieldAfter(left.id, 'dropdown')
    const right = store.getState().blocks[3]!
    const only = store.getState().addOption(right.id, 'Да')
    store.getState().placeInRow(right.groupId, left.groupId, 2, true)
    expect(packRows(groupBlocks(store.getState().blocks))).toHaveLength(1) // ряд собран

    // Стёрли единственный вариант правого — поле ушло, осталась голая подпись. До
    // отмены whitelist'а (2026-07-29) ряд на этом разваливался: группа без
    // отвечаемого блока участником не считалась. Теперь условие одно — «нет
    // внутреннего ряда», и подпись остаётся полноправной ячейкой, унося бит с собой.
    store.getState().removeOption(right.id, only)

    expect(types(store)).toEqual(['title', 'short_text', 'title'])
    expect(packRows(groupBlocks(store.getState().blocks))).toHaveLength(1)
    expect(store.getState().blocks.map((b) => b.settings?.column ?? '-')).toEqual([
      1,
      '-',
      2,
    ])
  })

  it('голый заголовок прямо НАД следующим вопросом остаётся одиночкой', () => {
    const store = createBuilderStore()
    store.getState().addFieldAfter(null, 'single_choice') // [t1, choice]
    const dead = store.getState().blocks[1]!
    const only = store.getState().addOption(dead.id, 'Да')
    store.getState().addQuestionAfter(dead.id, 'email') // [t1, choice, t2, email]

    store.getState().removeOption(dead.id, only)

    // Подпись мёртвого вопроса стоит вплотную над чужим — и НЕ прилипает к нему:
    // у группы «подпись + поле» подпись ровно одна, ближайшая к полю. Автор видит
    // осиротевший заголовок и решает сам, что с ним делать.
    expect(types(store)).toEqual(['title', 'title', 'email'])
    const groups = groupBlocks(store.getState().blocks)
    expect(groups).toHaveLength(2)
    const b = store.getState().blocks
    expect(b[0]!.groupId).not.toBe(b[2]!.groupId)
    expect(b[1]!.groupId).toBe(b[2]!.groupId)
  })

  it('duplicateBlock на таком поле дублирует вопрос целиком', () => {
    const store = createBuilderStore()
    store.getState().addFieldAfter(null, 'scale') // [title, scale]
    const scale = store.getState().blocks[1]!

    store.getState().duplicateBlock(scale.id)

    expect(types(store)).toEqual(['title', 'scale', 'title', 'scale'])
    const [, , copyTitle, copyField] = store.getState().blocks
    expect(copyTitle!.groupId).toBe(copyField!.groupId) // копия — своя группа
    expect(copyField!.id).not.toBe(scale.id)
  })

  it('Alt+↑↓ на подписи вопроса двигает всю группу, а не строку', () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // [t1, f1]
    store.getState().addQuestionAfter(store.getState().blocks[1]!.id, 'email') // [t1,f1,t2,f2]
    const secondTitle = store.getState().blocks[2]!

    store.getState().moveBlock(secondTitle.id, 'up')

    // Второй вопрос уехал наверх целиком; подпись не осталась среди чужих строк.
    expect(types(store)).toEqual(['title', 'email', 'title', 'short_text'])
    expect(store.getState().blocks[0]!.groupId).toBe(store.getState().blocks[1]!.groupId)
  })

  it('Alt+↑↓ на ОДИНОКОЙ подписи двигает её как обычный блок', () => {
    const store = createBuilderStore()
    store.getState().addBlock('text')
    store.getState().addBlock('label') // одинокая подпись без поля
    const labelId = store.getState().blocks[1]!.id

    store.getState().moveBlock(labelId, 'up')

    expect(types(store)).toEqual(['label', 'text'])
  })
})

// Собранный вопрос (подпись + поле) — целый: второго заголовка и второго ответа в
// нём не бывает (решение владельца 2026-07-26). Правило держат три входа сразу —
// regroup (кого группа принимает), вставка из меню и дроп.
describe('createBuilderStore — целая группа не принимает второй заголовок', () => {
  const question = () => {
    const store = createBuilderStore()
    store.getState().addQuestionAfter(null, 'short_text') // [title, short_text]
    return { store, titleId: store.getState().blocks[0]!.id }
  }

  it('«+» с подписью кладёт её ПОД вопрос, а не внутрь', () => {
    const { store, titleId } = question()

    const id = store.getState().addBlockAfter(titleId, 'label')

    const b = store.getState().blocks
    expect(b.map((x) => x.type)).toEqual(['title', 'short_text', 'label'])
    // Новая подпись — одиночка: своего поля у неё пока нет, чужое она не забирает.
    expect(b.find((x) => x.id === id)!.groupId).not.toBe(b[0]!.groupId)
    expect(b[0]!.groupId).toBe(b[1]!.groupId)
  })

  it('лэйаут внутрь вопроса по-прежнему встаёт — это его тело', () => {
    const { store, titleId } = question()

    store.getState().addBlockAfter(titleId, 'text')

    const b = store.getState().blocks
    expect(b.map((x) => x.type)).toEqual(['title', 'text', 'short_text'])
    expect(new Set(b.map((x) => x.groupId)).size).toBe(1)
  })

  it('правило вставки не распространяется на дроп: подпись падает в середину вопроса', () => {
    const { store, titleId } = question()
    store.getState().addBlockAfter(titleId, 'text') // [title, text, short_text]
    const store2 = store.getState()
    store2.addBlockAfterGroup(store2.blocks[2]!.id, 'label') // одинокая подпись ниже
    const b = store.getState().blocks
    const lone = b[3]!

    // Целимся в середину чужой группы: вставка сюда не пускает, перенос — пускает
    // (§4.1 спеки фазы 15), и подпись оказывается ближайшей к полю.
    const plan = planBlockDrop(b, lone.id, b[0]!.id)

    expect(plan!.blocks.map((x) => x.type)).toEqual(['title', 'label', 'text', 'short_text'])
  })
})

describe('createBuilderStore — заголовок формы приколот первой строкой (фаза 15)', () => {
  // Полотно прячет заголовок из списка групп (SlashEditor рисует его отдельной
  // строкой), поэтому команды переноса его не видят. Без страховки в сторе первый
  // вопрос уезжал ВЫШЕ заголовка, и документ переставал проходить валидацию — автор
  // получал «ошибку сохранения» без причины на жест, который выглядел безобидным.
  const withTitle = (): FormSchema => ({
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      { id: 'ft_x', groupId: 'g_ft_x', type: 'form_title', text: textFromString('Анкета') },
      { id: 'q1', groupId: 'g_a1', type: 'title', text: textFromString('Имя') },
      { id: 'a1', groupId: 'g_a1', type: 'short_text', settings: {} },
      { id: 'q2', groupId: 'g_a2', type: 'title', text: textFromString('Почта') },
      { id: 'a2', groupId: 'g_a2', type: 'email', settings: {} },
    ],
  })

  const loaded = () => {
    const store = createBuilderStore()
    store.getState().hydrate(formSchemaSchema.parse(withTitle()))
    return store
  }

  it('Alt+Shift+↑ на первом вопросе — no-op, а не выталкивание заголовка', () => {
    const store = loaded()

    store.getState().moveGroup('q1', 'up')

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['ft_x', 'q1', 'a1', 'q2', 'a2'])
    // Граница полотна не считается правкой: ни истории, ни dirty, ни лишнего PATCH.
    expect(store.getState().dirty).toBe(false)
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  it('Alt+↑ на первой строке формы — no-op', () => {
    const store = loaded()

    store.getState().moveBlock('q1', 'up')

    expect(store.getState().blocks[0]!.type).toBe('form_title')
    expect(store.getState().dirty).toBe(false)
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  it('перенос вниз через заголовок не мешает — обычный обмен работает', () => {
    const store = loaded()

    store.getState().moveGroup('q1', 'down')

    expect(store.getState().blocks.map((b) => b.id)).toEqual(['ft_x', 'q2', 'a2', 'q1', 'a1'])
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  it('дроп блока на позицию заголовка возвращает заголовок наверх', () => {
    const store = loaded()

    // Прямой вызов операции dnd: в UI зона заголовка недостижима (его нет в
    // sortable-вселенной), но стор обязан оставаться честным сам по себе —
    // страховка живёт в structural(), а не в каждой команде.
    store.getState().reorderBlocks('q1', null)

    expect(store.getState().blocks[0]!.type).toBe('form_title')
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  it('заголовок формы не втягивается в секцию первым вопросом', () => {
    // Бит у ПЕРВОГО вопроса приезжает из старой формы (в v3 он был инертен: рендерер
    // считает ряды уже без заголовка). Стор обязан прочитать документ так же, как
    // рендерер: заголовок вне потока вопросов, делить с ним колонку нельзя (ADR §10),
    // и уж точно нельзя пометить его битом — схема такого не принимает.
    const store = createBuilderStore()
    const doc = withTitle()
    doc.blocks[1]!.settings = { column: 2 }
    store.getState().hydrate(formSchemaSchema.parse(doc))

    const blocks = store.getState().blocks
    expect(blocks[0]!.settings?.column).toBeUndefined()
    expect(blocks[1]!.settings?.column).toBeUndefined()
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })
})

// Оформление страницы (обложка и логотип) — поля документа, а не блоки. Главное,
// что здесь проверяется: они попали в СНАПШОТ истории. Новое поле документа теряется
// в undo молча — сломанный откат выглядит как «обложка сама вернулась».
describe('createBuilderStore — обложка и логотип', () => {
  it('setCover ставит цвет и помечает dirty; toSchema несёт обложку', () => {
    const store = createBuilderStore()
    expect(store.getState().cover).toBeUndefined()

    store.getState().setCover({ color: '#ff8800' })
    expect(store.getState().cover).toEqual({ color: '#ff8800' })
    expect(store.getState().dirty).toBe(true)
    expect(store.getState().toSchema().cover).toEqual({ color: '#ff8800' })
  })

  // Ключа быть не должно вовсе: cover: {} и logo: {} контракт отвергает (422), и
  // «оформления нет» выражается только отсутствием объекта.
  it('без оформления toSchema не несёт ключей cover/logo', () => {
    const schema = createBuilderStore().getState().toSchema()
    expect('cover' in schema).toBe(false)
    expect('logo' in schema).toBe(false)
  })

  it('обложка и логотип переживают undo/redo', () => {
    const store = createBuilderStore()
    store.getState().setCover({ imageKey: 'ws/a.jpg' })
    store.getState().setLogo({ imageKey: 'ws/logo.png' })

    store.getState().undo()
    expect(store.getState().logo).toBeUndefined()
    expect(store.getState().cover).toEqual({ imageKey: 'ws/a.jpg' })

    store.getState().undo()
    expect(store.getState().cover).toBeUndefined()

    store.getState().redo()
    expect(store.getState().cover).toEqual({ imageKey: 'ws/a.jpg' })
  })

  it('setCover(undefined) снимает обложку', () => {
    const store = createBuilderStore()
    store.getState().setCover({ color: '#ff8800' })
    store.getState().setCover(undefined)
    expect(store.getState().cover).toBeUndefined()
    expect('cover' in store.getState().toSchema()).toBe(false)
  })

  it('setCoverY двигает точку фокуса картинки, ноль не теряется', () => {
    const store = createBuilderStore()
    store.getState().setCover({ imageKey: 'ws/a.jpg' })

    store.getState().setCoverY(0)
    expect(store.getState().cover).toEqual({ imageKey: 'ws/a.jpg', y: 0 })

    store.getState().setCoverY(80)
    expect(store.getState().cover?.y).toBe(80)
  })

  // Жест перетаскивания коммитится один раз, на отпускании, поэтому коалесить внутри
  // него нечего — а два жеста подряд обязаны остаться двумя шагами отмены. С «липким»
  // тегом они слились бы в один, и Mod+Z прыгал бы через положение.
  it('два сдвига подряд — два шага отмены', () => {
    const store = createBuilderStore()
    store.getState().setCover({ imageKey: 'ws/a.jpg' })

    store.getState().setCoverY(20)
    store.getState().setCoverY(70)

    store.getState().undo()
    expect(store.getState().cover?.y).toBe(20)
    store.getState().undo()
    expect(store.getState().cover?.y).toBeUndefined()
  })

  // У цвета двигать нечего, и схема такой документ отвергает: стор не должен уметь
  // выразить состояние, за которое автосейв получит 422.
  it('setCoverY по цветной обложке — no-op', () => {
    const store = createBuilderStore()
    store.getState().setCover({ color: '#ff8800' })
    const before = store.getState().past.length

    store.getState().setCoverY(30)
    expect(store.getState().cover).toEqual({ color: '#ff8800' })
    expect(store.getState().past.length).toBe(before)
  })

  it('hydrate загружает оформление из схемы', () => {
    const store = createBuilderStore()
    store.getState().hydrate({
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { imageKey: 'ws/a.jpg', y: 10 },
      logo: { imageKey: 'ws/logo.png' },
    })
    expect(store.getState().cover).toEqual({ imageKey: 'ws/a.jpg', y: 10 })
    expect(store.getState().logo).toEqual({ imageKey: 'ws/logo.png' })
  })

  // Разрыв страницы (фаза 19). Спецслучая в regroup он не требует — как не потребовал
  // form_title: связь «подпись → поле» ищется от поля ВВЕРХ через text/image, а разрыв
  // ни то ни другое. Проверяем следствие, ради которого это важно: вопрос не может
  // оказаться разорванным границей страниц (подпись на одной, поле на другой).
  it('разрыв не даёт подписи и полю попасть в одну группу', () => {
    const store = createBuilderStore()
    store.getState().hydrate({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'cap', groupId: '', type: 'title', text: textFromString('Вопрос') },
        { id: 'brk', groupId: '', type: 'page_break' },
        { id: 'fld', groupId: '', type: 'short_text' },
      ],
    })
    const [cap, brk, fld] = store.getState().blocks
    expect(cap!.groupId).not.toBe(fld!.groupId)
    expect(brk!.groupId).not.toBe(cap!.groupId)
    expect(brk!.groupId).not.toBe(fld!.groupId)
  })

  // Перетаскивание границы страницы — не отдельная команда, а обычный перенос группы:
  // документ линейный, поэтому «сдвинул разрыв» и «вопрос сменил страницу» — одно и то
  // же событие. Проверяем следствие, а не механику.
  it('перенос разрыва переводит вопрос на другую страницу', () => {
    const store = createBuilderStore()
    store.getState().hydrate({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'a', groupId: '', type: 'short_text' },
        { id: 'brk', groupId: '', type: 'page_break' },
        { id: 'b', groupId: '', type: 'email' },
      ],
    })
    const before = splitPages(store.getState().blocks).map((p) => p.map((b) => b.id))
    expect(before).toEqual([['a'], ['b']])

    store.getState().moveGroup('brk', 'up')

    // Разрыв уехал выше первого вопроса — страница перед ним пуста, значит её нет, и оба
    // вопроса снова на одной.
    const after = splitPages(store.getState().blocks).map((p) => p.map((b) => b.id))
    expect(after).toEqual([['a', 'b']])
  })

  // Тот же дефект, что чинит сторож в rowZones.test, со стороны клавиатуры: подсказка
  // «войти в ряд» (rowPosition → 'enter') обещала Mod+Alt+→ там, где placeInRow вернёт
  // null. Найдено ревью фазы 19.
  it('вопрос под разрывом в ряд с ним не встаёт — ни подсказкой, ни командой', () => {
    const store = createBuilderStore()
    store.getState().hydrate({
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'a', groupId: '', type: 'short_text' },
        { id: 'brk', groupId: '', type: 'page_break' },
        { id: 'b', groupId: '', type: 'email' },
      ],
    })
    expect(rowPosition(store.getState().blocks, 'b')).toEqual({ kind: 'solo' })

    const before = store.getState().blocks
    store.getState().shiftColumn('b', 'right')
    expect(store.getState().blocks).toEqual(before)
  })

  it('разрыв, вставленный редактором, валиден по контракту', () => {
    const store = createBuilderStore()
    store.getState().addBlock('short_text')
    store.getState().addBlock('page_break')
    store.getState().addBlock('email')
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })

  // Сторож контракта: то, что стор отдаёт автосейву, обязано проходить Zod.
  it('документ с оформлением валиден по контракту', () => {
    const store = createBuilderStore()
    store.getState().setCover({ imageKey: 'ws/a.jpg' })
    store.getState().setCoverY(0)
    store.getState().setLogo({ imageKey: 'ws/logo.png' })
    expect(formSchemaSchema.safeParse(store.getState().toSchema()).success).toBe(true)
  })
})

// СОСТАВ ДОКУМЕНТА СВЕРЯЕТСЯ МАШИННО. Список DOCUMENT_FIELDS — то, по чему автосейв
// узнаёт о правке; toSchema — то, что уезжает на сервер. Разойдись они, и поле
// сохраняется только «за компанию» с чужой правкой: в фазе 22 так молча потерялось
// оформление — шторка ставила dirty, но сохранение не планировала.
//
// Тест строит документ, в котором заданы ВСЕ необязательные поля: иначе toSchema их
// опускает (ключа нет, когда значения нет), и сверять было бы нечего.
it('DOCUMENT_FIELDS покрывает весь состав toSchema', () => {
  const store = createBuilderStore()
  store.getState().setSubmitLabel('Готово')
  store.getState().setAfterSubmit({ thankYouText: 'Спасибо', redirectUrl: 'https://example.com' })
  store.getState().setCover({ imageKey: 'k' })
  store.getState().setLogo({ imageKey: 'k' })
  store.getState().setDesign({ theme: 'dark' })

  const keys = Object.keys(store.getState().toSchema()).filter((k) => k !== 'schemaVersion')
  expect(keys.sort()).toEqual([...DOCUMENT_FIELDS].sort())
})
