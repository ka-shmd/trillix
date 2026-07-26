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
  isAnswerableType,
  isCaptionType,
  carriesText,
  canShareRow,
  COLUMN_RIGHT,
} from '@entities/formSchema'
import { groupBlocks, packOptionRows, packRows } from '@fields/groups'

// Стор билдера — высокочастотный локальный документ формы (ARCHITECTURE §5.1):
// каждая правка text — синхронная операция над стором, мгновенный UI, а
// дебаунс-автосейв (шаг 6) шлёт весь draft_schema. Здесь только сам документ и
// операции над ним; React-обвязки нет — стор чистый и тестируется vitest напрямую.
//
// Модель v2 (фаза 8.7): вопрос — ГРУППА блоков (подпись + контент + поле). Стор
// держит плоский список блоков-строк, а groupId ВЫВОДИТСЯ из раскладки функцией
// regroup после каждой структурной правки: группа — это либо «подпись…поле» (и всё
// между ними), либо голое поле; остальные блоки — одиночки (правило целиком — у
// regroup). Так редактор остаётся списком строк, а на выходе — валидные смежные
// группы (≤1 отвечаемого в группе), и подпись привязана к полю явным groupId (не
// позицией при чтении на бэке).
//
// Фабрика (а не модульный синглтон): билдер открывает конкретную форму, при
// смене formId нужен свежий стор — контекст-провайдер создаёт по одному на
// инстанс, а тесты — по одному на кейс.

// Стабильные client-side id блока/опции. Префикс — для читаемости JSON;
// уникальность держится на случайности UUID. Сервер (ValidateSchema) — финальная
// проверка непустоты/длины/уникальности.
const newBlockId = (): string => `blk_${crypto.randomUUID()}`
const newOptionId = (): string => `opt_${crypto.randomUUID()}`

// Редактируемые поля блока. id/groupId/type через updateBlock не меняются: id
// стабилен (ответы), groupId выводится regroup, смена типа — отдельная операция.
export type BlockPatch = Partial<Pick<Block, 'text' | 'required' | 'settings'>>

// Snapshot — снимок документа (blocks + поля формы-уровня) для стеков undo/redo.
// dirty — производный UI, в снапшот не входит. Фокус — не стейт стора (живёт в
// фокус-движке полотна, §2.5), поэтому откат его не касается. Новое поле документа
// обязано попасть сюда, иначе undo его молча потеряет.
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
  // строку. Вставка ВНУТРЬ группы (Shift+Enter §3.2): новая строка ложится сразу
  // под текущую, regroup оставляет её в той же группе (контент между подписью и
  // полем). Enter (после всей группы) — addBlockAfterGroup.
  addBlockAfter: (afterId: string | null, type: BlockType) => string
  // addBlockAfterGroup вставляет блок ПОСЛЕ всей группы afterId (Enter §3.2: новая
  // строка не втискивается в текущий вопрос, а начинает следующий блок под ним) и
  // возвращает его id. В конец при null/ненайденном.
  addBlockAfterGroup: (afterId: string | null, type: BlockType) => string
  // changeBlockType меняет тип блока на месте (id стабилен): раздел «Отдельные
  // поля»/«Лэйаут» меню и Backspace-схлопывание. Текст переносится, если новый тип
  // его несёт. Возвращает id для фокуса.
  changeBlockType: (id: string, type: BlockType) => string
  // makeQuestion — inline-«/», раздел «Вопросы». Одиночный блок → он становится
  // подписью, поле под ним; блок внутри группы → новый вопрос НИЖЕ группы (инпут не
  // встраивается между подписью и контролом). Возвращает id для фокуса.
  makeQuestion: (id: string, type: BlockType) => string
  // makeField — inline-«/», раздел «Отдельные поля». Одиночный блок → конверсия на
  // месте в голое поле; блок внутри группы → голое поле новой группой ниже.
  makeField: (id: string, type: BlockType) => string
  // addQuestionAfter вставляет вопрос-бандл (подпись title + поле) ПОСЛЕ всей группы
  // afterId (инпут начинает новую группу). Диалог «+», раздел «Вопросы».
  addQuestionAfter: (afterId: string | null, type: BlockType) => string
  // addFieldAfter вставляет голое поле ПОСЛЕ всей группы afterId. Диалог «+», раздел
  // «Отдельные поля».
  addFieldAfter: (afterId: string | null, type: BlockType) => string
  updateBlock: (id: string, patch: BlockPatch) => void
  removeBlock: (id: string) => void
  // removeGroup удаляет всю группу блока (подпись владеет группой): trash по подписи
  // сносит подпись + контент + поле. На несуществующем блоке — no-op.
  removeGroup: (id: string) => void
  // moveBlock двигает блок на одну позицию; на границе списка — no-op (dirty не трогает).
  moveBlock: (id: string, dir: 'up' | 'down') => void
  // moveGroup переставляет группу блока id с соседней (Alt+Shift+↑/↓ §3.2): группа
  // едет целиком, внутренний порядок цел, каретка остаётся на том же блоке (id
  // стабилен). На границе полотна — no-op (dirty не трогает).
  moveGroup: (id: string, dir: 'up' | 'down') => void
  // reorderBlocks переносит БЛОК activeId на позицию overId (блочный слой dnd —
  // плоский сплайс; regroup пересчитает группы). Перенос ГРУППЫ как единицы —
  // reorderGroups: UI даёт подписи мульти-группы групповую ручку, сюда она не
  // попадает. Неизвестный id или та же позиция — no-op (dirty не трогает).
  reorderBlocks: (activeId: string, overId: string) => void
  // reorderGroups переносит ГРУППУ activeGroupId на позицию группы overGroupId
  // (dnd уровня групп — группа перетаскивается как единица). Внутренний порядок
  // блоков группы сохраняется. Неизвестный id или та же группа — no-op.
  reorderGroups: (activeGroupId: string, overGroupId: string) => void
  duplicateBlock: (id: string) => void
  // placeInRow — команда ПЕРЕНОСА в правую ячейку ряда (спека §5), единственный вход
  // и для жеста (дроп в правую треть ряда), и для Mod+Alt+→: группа activeGroupId
  // встаёт вплотную ЗА targetGroupId и получает column='right'. Не режим и не
  // тумблер. Ряд цели полон / цель не умеет делить ряд → флаг инертен, и вся команда
  // откатывается (no-op, историю и dirty не трогает).
  placeInRow: (activeGroupId: string, targetGroupId: string) => void
  // takeOwnRow — обратная команда (Mod+Alt+←, обычный вертикальный дроп): вопрос
  // возвращается своим рядом. Порядок блоков не меняется — снимается только бит.
  takeOwnRow: (id: string) => void
  // Те же две команды для варианта (спека §5.1: различий с блоками нет ни одного).
  placeOptionInRow: (blockId: string, activeOptionId: string, targetOptionId: string) => void
  takeOptionOwnRow: (blockId: string, optionId: string) => void
  // Редактор опций choice-блока. На non-choice и несуществующем блоке — no-op.
  addOption: (blockId: string) => void
  // addOptionAfter вставляет пустой вариант СРАЗУ ПОСЛЕ optionId (Enter §3.2: вариант
  // рождается под текущим, а не в конце — дефект Д5) и возвращает его id для фокуса.
  // На non-choice/ненайденном варианте — no-op (возвращённый id тогда не всплывёт).
  addOptionAfter: (blockId: string, optionId: string) => string
  updateOption: (blockId: string, optionId: string, label: string) => void
  // reorderOptions переносит вариант activeOptionId на позицию overOptionId (dnd
  // вариантов, спека §5.1) — сплайс, как reorderBlocks. Незнакомые id — no-op.
  reorderOptions: (blockId: string, activeOptionId: string, overOptionId: string) => void
  removeOption: (blockId: string, optionId: string) => void
  moveOption: (blockId: string, optionId: string, dir: 'up' | 'down') => void
  // setSubmitLabel меняет текст кнопки отправки (форма-уровень).
  setSubmitLabel: (label: string) => void
  // setAfterSubmit применяет настройки экрана «после отправки» целиком. Одним
  // действием, а не полем за полем: страница настроек сохраняется по кнопке, и
  // нажатие обязано быть одним шагом отмены. Никаких правок — no-op (историю и
  // dirty не трогает).
  setAfterSubmit: (settings: { thankYouText: string; redirectUrl: string }) => void
  // undo/redo откатывают и повторяют изменения документа. Возвращают id блока для
  // каретки после отката (§2.4, firstDiffFocus) — фокус-движок его потребляет; пустой
  // стек / нечего фокусировать — null (no-op / каретка на заголовок).
  undo: () => string | null
  redo: () => string | null
  // markSaved снимает dirty после успешного PATCH (автосейв — шаг 6).
  markSaved: () => void
  // toSchema сериализует документ для отправки на бэкенд.
  toSchema: () => FormSchema
}

export type BuilderStore = BuilderState & BuilderActions

// newBlock создаёт валидный черновой блок: пустой text, выведенный позже groupId,
// дефолты. Choice-тип стартует с пустым списком опций — допустимое недособранное
// состояние; non-choice остаётся с пустыми settings (иначе ValidateSchema отвергнет
// опции у не-choice).
export function newBlock(type: BlockType): Block {
  const base: Block = {
    id: newBlockId(),
    groupId: '', // проставит regroup
    type,
    text: '',
    required: false,
    settings: {},
  }
  if (isChoiceType(type)) return { ...base, settings: { options: [] } }
  // Согласие создаётся обязательным: это дефолт, а не правило типа (решение
  // владельца) — владелец может выключить, если это маркетинг-opt-in.
  if (type === 'consent') return { ...base, required: true }
  // Шкала создаётся с диапазоном: схема без него валидна (недособранный черновик),
  // но респонденту нужен готовый ряд делений, а не пустота.
  if (type === 'scale') {
    return { ...base, settings: { scaleMin: DEFAULT_SCALE_MIN, scaleMax: DEFAULT_SCALE_MAX } }
  }
  return base
}

// newFieldBlock — поле, создаваемое ВОПРОСНЫМ жестом (makeQuestion/makeField и
// диалоги addQuestionAfter/addFieldAfter): choice-тип рождается с ОДНИМ пустым
// вариантом, а не с пустым списком. Так choice сразу даёт каретке место (§2.1) и
// клавиатурный поток вариантов работает с первого нажатия. addBlock/changeBlockType
// оставляют choice с пустым списком (недособранный черновик — там вариант появится
// вводом), поэтому сид живёт здесь, а не в newBlock.
function newFieldBlock(type: BlockType): Block {
  const b = newBlock(type)
  if (isChoiceType(type)) return { ...b, settings: { options: [{ id: newOptionId(), label: '' }] } }
  return b
}

// regroup выводит groupId из раскладки. Правило (v2, фаза 8.7): группами считаются
// ровно ДВЕ сущности —
//   1. ВОПРОС: подпись (title/label) + отвечаемое поле, и всё МЕЖДУ ними
//      (контент text/image). Связь ищется ОТ ПОЛЯ ВВЕРХ: ближайшая подпись над
//      полем через контент. Подряд идущие подписи над найденной (title над label)
//      входят в ту же группу (title перебивает label в аналитике).
//   2. ГОЛОЕ ПОЛЕ: отвечаемый блок без подписи над ним — группа из него одного.
// ВСЁ ОСТАЛЬНОЕ — одиночки: standalone-абзац/картинка, heading, подпись без поля.
// Это не упрощение, а требование dnd: жадная группировка (подпись «открывает»
// группу и копит всё после себя) склеивала подряд идущие лэйаут-блоки в одну
// группу — внутри склейки нет границ групп, и уронить туда перетаскиваемую группу
// было нельзя. Одиночки дают границу после КАЖДОГО standalone-блока. heading в
// вопрос не входит никогда (раздел — не подпись поля). Инварианты v2 держатся:
// группа смежна, ≤1 отвечаемого. groupId детерминирован (id якоря: отвечаемого
// блока, иначе самого блока-одиночки) — стабилен между правками. Возвращает НОВЫЙ
// массив, только если хоть у одного блока groupId изменился (иначе тот же —
// commit no-op).
function regroup(blocks: Block[]): Block[] {
  // anchor[i] — id якоря группы блока i; null после прохода = одиночка (якорь — сам).
  const anchor = new Array<string | null>(blocks.length).fill(null)
  let floor = 0 // блоки до floor уже розданы предыдущим группам-вопросам
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (!isAnswerableType(b.type)) continue
    // От поля вверх через контент — до ближайшей подписи (не заходя в чужую группу).
    let j = i - 1
    while (j >= floor && (blocks[j]!.type === 'text' || blocks[j]!.type === 'image')) j--
    if (j >= floor && isCaptionType(blocks[j]!.type)) {
      let s = j // подряд идущие подписи выше — в ту же группу (title над label)
      while (s > floor && isCaptionType(blocks[s - 1]!.type)) s--
      for (let k = s; k <= i; k++) anchor[k] = b.id
    } else {
      anchor[i] = b.id // голое поле — группа из одного блока
    }
    floor = i + 1
  }
  let changed = false
  const next = blocks.map((b, i) => {
    const g = `g_${anchor[i] ?? b.id}`
    if (g === b.groupId) return b
    changed = true
    return { ...b, groupId: g }
  })
  return changed ? next : blocks
}

// carryLayout переносит бит ряда со старого блока на сконвертированный, если новый
// тип умеет делить ряд; вне whitelist ключ молча роняется — иначе автосейв ловил бы
// 422 на невалидном сочетании (спека §5). Мутирует dst (свежесозданный блок
// конверсии, ещё не в сторе).
function carryLayout(src: Block, dst: Block): void {
  if (src.settings?.column === COLUMN_RIGHT && canShareRow(dst.type)) {
    dst.settings = { ...dst.settings, column: COLUMN_RIGHT }
  }
}

// withoutColumn/optionWithoutColumn снимают бит ряда (канон хранит только отклонение
// — ключ просто удаляется). У блока он лежит в settings, у варианта — прямо на нём.
// Возвращают тот же объект, если снимать нечего.
function withoutColumn(b: Block): Block {
  if (b.settings?.column === undefined) return b
  const settings = { ...b.settings }
  delete settings.column
  return { ...b, settings }
}

function optionWithoutColumn(o: Option): Option {
  if (o.column === undefined) return o
  const next = { ...o }
  delete next.column
  return next
}

// rowPartners — для каждого носителя бита: id блока-соседа, РЯДОМ С КОТОРЫМ он реально
// стоит (носитель левого участника). Ключ — id носителя, а не groupId: groupId выводится
// regroup и может смениться от чужой правки, id блока стабилен (на него же ссылаются
// answers).
function rowPartners(blocks: Block[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const row of packRows(groupBlocks(blocks))) {
    if (row.length < 2) continue
    const left = row[0]!.blocks.find((b) => isAnswerableType(b.type))
    const right = row[1]!.blocks.find((b) => b.settings?.column === COLUMN_RIGHT)
    if (left && right) m.set(right.id, left.id)
  }
  return m
}

// То же для вариантов: сосед варианта — предыдущий вариант его ряда.
function optionPartners(options: Option[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const row of packOptionRows(options)) {
    if (row.length > 1) m.set(row[1]!.id, row[0]!.id)
  }
  return m
}

// normalizeColumns снимает биты ряда, которые перестали значить то, что значили (спека
// §5) — и у блоков, и у вариантов. Снимаются два вида:
//
//  1. ИНЕРТНЫЙ — флаг, которому некуда примениться: левого соседа нет, он не умеет
//     делить ряд, его ячейка занята. Такой флаг легален в контракте (кросс-блочное
//     условие намеренно не валидируется — иначе undo и промежуточные состояния драга
//     ловили бы 422), но в сторе его чистят, чтобы он не воскрес: иначе вставка
//     короткого вопроса выше молча затянула бы блок в чужой ряд.
//  2. С ПОДМЕНЁННЫМ СОСЕДОМ — флаг остался рабочим, но сосед у него уже другой. Бит
//     держится за КОНКРЕТНОГО соседа: «встань в ряд с этим вопросом», а не «встань в
//     ряд с кем угодно, кто окажется выше». Без этого правила любой вертикальный
//     перенос (Alt+Shift+↑↓, дроп группы, перестановка вариантов) приклеивал бы
//     участника ряда к постороннему вопросу — ряд собирался бы сам, без просьбы.
//     Проверяется только при известном prev (структурная правка); hydrate и undo/redo
//     приезжают со своей историей и подмены не видят — им сравнивать не с чем и не нужно.
//     placed — единственное исключение: элемент, которому бит поставили ИМЕННО СЕЙЧАС
//     (placeInRow), меняет соседа по прямой просьбе, и снимать его бит нельзя, иначе
//     перенос из одного ряда в свободную ячейку другого был бы no-op'ом.
//
// Что именно стоит в ряду, решает ТОТ ЖЕ раскладчик, что рисует ряды (packRows/
// packOptionRows): своё правило здесь разъехалось бы с рендером — это и был дефект
// «помечен half — нарисован full».
// Возвращает исходный массив, если снимать нечего (дешёвые no-op коммиты).
function normalizeColumns(blocks: Block[], prev?: Block[], placed?: string): Block[] {
  const clear = new Set<string>() // id блоков, с которых снимаем бит
  for (const row of packRows(groupBlocks(blocks))) {
    for (const b of row[0]!.blocks) {
      if (b.settings?.column === COLUMN_RIGHT) clear.add(b.id) // (1) инертный
    }
  }
  if (prev) {
    // (2) сосед сменился. Носителей, которых в prev не было вовсе, не трогаем: это
    // свежий бит от placeInRow, ему сравнивать не с чем.
    const was = rowPartners(prev)
    const now = rowPartners(blocks)
    for (const [id, partner] of now) {
      const before = was.get(id)
      if (id !== placed && before !== undefined && before !== partner) clear.add(id)
    }
  }
  // Варианты — тот же приём внутри каждого choice-блока.
  const optClear = new Map<string, Set<string>>()
  const prevOptions = new Map(prev?.map((b) => [b.id, b.settings?.options ?? []]))
  for (const b of blocks) {
    const options = b.settings?.options
    if (!options?.length) continue
    const ids = new Set<string>()
    for (const row of packOptionRows(options)) {
      if (row[0]!.column === COLUMN_RIGHT) ids.add(row[0]!.id)
    }
    const before = prevOptions.get(b.id)
    if (before) {
      const was = optionPartners(before)
      for (const [id, partner] of optionPartners(options)) {
        const had = was.get(id)
        if (id !== placed && had !== undefined && had !== partner) ids.add(id)
      }
    }
    if (ids.size > 0) optClear.set(b.id, ids)
  }
  if (clear.size === 0 && optClear.size === 0) return blocks
  return blocks.map((b) => {
    const ids = optClear.get(b.id)
    const next = ids
      ? {
          ...b,
          settings: {
            ...b.settings,
            options: b.settings!.options!.map((o) => (ids.has(o.id) ? optionWithoutColumn(o) : o)),
          },
        }
      : b
    return clear.has(b.id) ? withoutColumn(next) : next
  })
}

// Свободна ли правая ячейка ряда, в котором стоит группа gid (аналог для варианта —
// ниже). Отдельного правила «цель должна быть свободна» и «в ряду максимум двое» в
// сторе нет: есть один вопрос к ТОМУ ЖЕ раскладчику, который рисует ряды, — физика
// ячеек. Ряд из одного = ячейка свободна.
function rowHasFreeCell(blocks: Block[], gid: string): boolean {
  const row = packRows(groupBlocks(blocks)).find((r) => r.some((g) => g.id === gid))
  return row?.length === 1
}

function optionRowHasFreeCell(options: Option[], optionId: string): boolean {
  const row = packOptionRows(options).find((r) => r.some((o) => o.id === optionId))
  return row?.length === 1
}

// groupAnswerable — отвечаемый блок группы gid (носитель бита ряда) или null.
function groupAnswerable(blocks: Block[], gid: string): Block | null {
  return blocks.find((b) => b.groupId === gid && isAnswerableType(b.type)) ?? null
}

// groupSpan — [начало, конец] непрерывного участка группы блока с индексом i.
// Группа смежна (гарантирует regroup), поэтому участок односвязный.
function groupSpan(blocks: Block[], i: number): [number, number] {
  const gid = blocks[i]!.groupId
  let s = i
  let e = i
  while (s > 0 && blocks[s - 1]!.groupId === gid) s--
  while (e < blocks.length - 1 && blocks[e + 1]!.groupId === gid) e++
  return [s, e]
}

// groupEndAfter — индекс вставки ПОСЛЕ всей группы afterId (в конец при null или
// ненайденном). Отвечаемое поле/бандл вставляется сюда: инпут не встраивается между
// подписью и контролом группы, а начинает новую группу ниже (фаза 8.7).
function groupEndAfter(blocks: Block[], afterId: string | null): number {
  if (!afterId) return blocks.length
  const i = blocks.findIndex((b) => b.id === afterId)
  if (i < 0) return blocks.length
  return groupSpan(blocks, i)[1] + 1
}

// planBlockDrop — чистый расчёт блочного дропа: activeId переносится на позицию
// overId (плоский сплайс, как arrayMove у sortable), но с правилом §4.4 спеки
// (Д11): отвечаемый блок И подпись (решение владельца — шире спеки, подпись тоже
// крадёт вопрос), уроненные МЕЖДУ строк чужой МУЛЬТИ-группы, приземляются сразу
// ПОД ней. Дроп внутрь молча пересобирал группу вокруг пришельца (regroup
// переклеивал подпись → колонки CSV и шаги воронки тихо переименовывались) —
// теперь dnd согласован с правилом слеш-меню «инпут не втискивается в чужой
// вопрос». Что остаётся свободным: подпись НАД голым полем (группа из одного
// блока — жест «дать полю подпись»), контент text/image внутрь группы (он и есть
// тело вопроса), перенос в границах СВОЕЙ группы.
// frameIds — состав для драг-рамки (union-rect строк на полотне): при
// перенаправлении — строки чужой группы, под которую уедет блок; иначе —
// мульти-группа, в которую активный блок войдёт после дропа (пусто, если
// останется одиночкой). changed=false — дроп вернул блок на своё же место
// (стору коммитить нечего, но рамке состав всё ещё нужен).
export function planBlockDrop(
  blocks: Block[],
  activeId: string,
  overId: string,
): { blocks: Block[]; changed: boolean; frameIds: string[]; redirected: boolean } | null {
  const from = blocks.findIndex((b) => b.id === activeId)
  const to = blocks.findIndex((b) => b.id === overId)
  if (from < 0 || to < 0 || from === to) return null
  const active = blocks[from]!
  const rest = blocks.slice()
  rest.splice(from, 1)
  let at = to // вставка на индекс overId в списке БЕЗ активного = arrayMove
  let redirected = false
  let frameIds: string[] = []
  if (isAnswerableType(active.type) || isCaptionType(active.type)) {
    // Мульти-группы ищутся по СТАРЫМ groupId остатка (группы смежны). Группа
    // самого активного блока исключена: перенос внутри своей — свободен, а её
    // groupId у остатка тот же, что у активного.
    let gs = 0
    while (gs < rest.length) {
      let ge = gs
      while (ge + 1 < rest.length && rest[ge + 1]!.groupId === rest[gs]!.groupId) ge++
      // «Внутрь» = слот строго между строками группы: gs < at ≤ ge.
      if (rest[gs]!.groupId !== active.groupId && ge > gs && at > gs && at <= ge) {
        at = ge + 1
        redirected = true
        frameIds = rest.slice(gs, ge + 1).map((b) => b.id)
        break
      }
      gs = ge + 1
    }
  }
  const next = rest.slice()
  next.splice(at, 0, active)
  const changed = !next.every((b, i) => b === blocks[i])
  if (!redirected) {
    const predicted = regroup(next)
    const gid = predicted.find((b) => b.id === activeId)!.groupId
    const members = predicted.filter((b) => b.groupId === gid)
    if (members.length > 1) frameIds = members.map((b) => b.id)
  }
  return { blocks: next, changed, frameIds, redirected }
}

// remapDropTarget — слой отклика того же правила §4.4: над какой строкой sortable
// должен раскрыть щель, чтобы она совпала с реальной точкой приземления (иначе
// строки чужой группы раздвигаются изнутри, а блок падает под неё — полотно врёт).
// Возвращает id строки-подмены или null (цель легальна, подмена не нужна).
// Направление имеет значение: arrayMove кладёт активный блок на индекс цели,
// поэтому «сразу под группой» из-под верха — это её последняя строка, а снизу —
// строка, следующая за группой (может оказаться самим активным блоком: over=self
// у sortable — «остаться на месте», что и требуется).
export function remapDropTarget(blocks: Block[], activeId: string, overId: string): string | null {
  const ai = blocks.findIndex((b) => b.id === activeId)
  const ti = blocks.findIndex((b) => b.id === overId)
  if (ai < 0 || ti < 0 || ai === ti) return null
  const active = blocks[ai]!
  if (!isAnswerableType(active.type) && !isCaptionType(active.type)) return null
  if (blocks[ti]!.groupId === active.groupId) return null
  const [gs, ge] = groupSpan(blocks, ti)
  if (ge === gs) return null // одиночка/голое поле — не мульти-группа
  if (ai < gs && ti < ge) return blocks[ge]!.id
  if (ai > ge && ti > gs) return blocks[ge + 1]!.id
  return null
}

// rowBoundaryTarget — РЯД АТОМАРЕН ДЛЯ ВЕРТИКАЛЬНОЙ ВСТАВКИ (спека §5). Полотно во
// время драга остаётся двумерным (в столбик не сворачивается), и ровно в одной позиции
// verticalListSortingStrategy врёт: цель «щель между участниками ряда». Уронённый туда
// блок либо сам занимает левую ячейку правого участника, либо гасит его бит — в обоих
// случаях ряд рвётся, а щель показывала не это. Лечится подменой цели границей ряда —
// ТЕМ ЖЕ приёмом, что §4.4 для чужих мульти-групп, и с тем же выбором направления:
// сверху — последняя строка ряда (блок ложится под ряд), снизу — строка за рядом.
//
// Вставки ВНУТРЬ участника ряда это не касается: контент, добавленный в вопрос, ряд не
// рвёт (участник остаётся тем же участником) — и остаётся легальным, как был.
// Композиция с §4.4 обязательна и в этом порядке: remapDropTarget сам может вернуть
// «под левым участником», а это и есть та самая щель.
export function rowBoundaryTarget(blocks: Block[], activeId: string, overId: string): string | null {
  const ai = blocks.findIndex((b) => b.id === activeId)
  const ti = blocks.findIndex((b) => b.id === overId)
  if (ai < 0 || ti < 0 || ai === ti) return null
  const at = (id: string) => blocks.findIndex((b) => b.id === id)
  for (const row of packRows(groupBlocks(blocks))) {
    if (row.length < 2) continue
    const rs = at(row[0]!.blocks[0]!.id) // первая строка ряда
    const mid = at(row[1]!.blocks[0]!.id) // первая строка ПРАВОГО участника
    const re = at(row[1]!.blocks[row[1]!.blocks.length - 1]!.id) // последняя строка ряда
    // Сначала «цель не в этом ряду» и только потом «активный из этого ряда»: обратный
    // порядок выходил из ЦИКЛА на первом же ряду, где нашёлся активный, и защита не
    // доставалась ни одному ряду ниже — участник верхнего ряда мог уронить блок в
    // щель нижнего.
    if (ti < rs || ti > re) continue
    if (ai >= rs && ai <= re) return null // цель в СВОЁМ ряду — перестановка свободна
    // Позиция вставки = индекс цели в исходном списке (арифметика planBlockDrop).
    // Сверху щель между участниками даёт цель «последняя строка левого», снизу —
    // «первая строка правого»; прочие цели внутри ряда легальны и ряд не рвут.
    if (ai < rs) return ti === mid - 1 ? blocks[re]!.id : null
    return ti === mid ? (blocks[re + 1]?.id ?? null) : null
  }
  return null
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
  // placed — вариант, которому бит ряда поставили именно сейчас (см. normalizeColumns).
  placed?: string,
): Pick<BuilderState, 'blocks'> | null {
  const block = blocks.find((b) => b.id === blockId)
  if (!block || !isChoiceType(block.type)) return null
  const options = block.settings?.options ?? []
  const next = fn(options)
  if (next === options) return null
  // normalizeColumns и здесь: у вариантов бит ряда ломается от тех же правок, что у
  // блоков (левого удалили, переставили порядок), и чистить его надо там же, где он
  // ломается. prev — сами blocks: перестановка вариантов обязана снимать бит с того,
  // у кого сменился сосед, иначе Alt+↑↓ приклеивал бы вариант к чужому ряду.
  return {
    blocks: normalizeColumns(
      blocks.map((b) => (b.id === blockId ? { ...b, settings: { ...b.settings, options: next } } : b)),
      blocks,
      placed,
    ),
  }
}

// firstDiffFocus — id блока, на который встаёт каретка после undo/redo (§2.4:
// «первый блок, которого коснулся откат; блок исчез → его сосед»). Сравниваем
// раскладку ДО и ПОСЛЕ отката по позициям: первое расхождение — по id (структурная
// правка) или по идентичности объекта (правка текста создаёт новый объект блока в
// commit). Если расхождение за концом восстановленного списка (откат удаления в
// хвосте) — последний блок как сосед; список пуст — null (каретка уйдёт на заголовок).
function firstDiffFocus(before: Block[], after: Block[]): string | null {
  const n = Math.min(before.length, after.length)
  let i = 0
  while (i < n && before[i]!.id === after[i]!.id && before[i] === after[i]) i++
  if (i < after.length) return after[i]!.id
  if (after.length > 0) return after[after.length - 1]!.id
  return null
}

// snapshot снимает документ (blocks + поля формы-уровня) для стеков истории.
const snapshot = (s: BuilderState): Snapshot => ({
  blocks: s.blocks,
  submitLabel: s.submitLabel,
  thankYouText: s.thankYouText,
  redirectUrl: s.redirectUrl,
})

// updateBlockTag коалесит непрерывный ввод через updateBlock: правки текстовых полей
// (text/settings-placeholder) в один блок делят шаг истории; патч с required (или
// иным дискретным полем) — свой шаг (тег null).
function updateBlockTag(id: string, patch: BlockPatch): string | null {
  const keys = Object.keys(patch)
  const textOnly = keys.length > 0 && keys.every((k) => k === 'text' || k === 'settings')
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

    // structural — патч, меняющий состав/порядок/типы блоков: пропускает blocks
    // через regroup, чтобы groupId всегда отражал раскладку, и normalizeColumns,
    // чтобы бит ряда не воскрес и не приклеился к новому соседу (спека §5).
    //
    // Прежнюю раскладку берём из get(): патч считается ВНУТРИ producer'а, до того как
    // set его применит, поэтому get() — это ещё «до». Так правило «сосед сменился —
    // бит снят» действует на ВСЕ структурные пути сразу (переносы, дропы, вставки),
    // а не на те, где о нём вспомнили: путь, который о нём забудет, — это молча
    // собравшийся ряд, которого никто не просил.
    function structural(
      patch: (Partial<BuilderState> & { blocks: Block[] }) | null,
      placed?: string,
    ) {
      if (patch === null) return null
      return { ...patch, blocks: normalizeColumns(regroup(patch.blocks), get().blocks, placed) }
    }

    return {
      blocks: [],
      submitLabel: '',
      thankYouText: '',
      redirectUrl: '',
      dirty: false,
      past: [],
      future: [],
      lastTag: null,

      hydrate: (schema) =>
        set({
          // normalizeColumns и здесь: контракт допускает инертный флаг (и правильно
          // делает), но редактор обязан начинать с документа, где флаг = реальный ряд
          // (dirty не ставится, на сервер уедет со следующей правкой).
          blocks: normalizeColumns(regroup(schema.blocks.map(cloneBlock))),
          submitLabel: schema.submitLabel ?? '',
          thankYouText: schema.thankYouText ?? '',
          redirectUrl: schema.redirectUrl ?? '',
          dirty: false,
          past: [],
          future: [],
          lastTag: null,
        }),

      addBlock: (type) => {
        const block = newBlock(type)
        commit(null, (s) => structural({ blocks: [...s.blocks, block] }))
      },

      addBlockAfter: (afterId, type) => {
        const block = newBlock(type)
        commit(null, (s) => {
          const i = afterId ? s.blocks.findIndex((b) => b.id === afterId) : -1
          const at = i >= 0 ? i + 1 : s.blocks.length
          const blocks = s.blocks.slice()
          blocks.splice(at, 0, block)
          return structural({ blocks })
        })
        return block.id
      },

      addBlockAfterGroup: (afterId, type) => {
        const block = newBlock(type)
        commit(null, (s) => {
          const at = groupEndAfter(s.blocks, afterId)
          const blocks = s.blocks.slice()
          blocks.splice(at, 0, block)
          return structural({ blocks })
        })
        return block.id
      },

      changeBlockType: (id, type) => {
        commit(null, (s) => {
          const src = s.blocks.find((b) => b.id === id)
          if (!src) return null
          // Конверсия на месте (id стабилен): дефолты нового типа + перенос текста,
          // если новый тип его несёт (иначе текст роняется — у поля его нет).
          const converted: Block = {
            ...newBlock(type),
            id,
            text: carriesText(type) ? src.text : '',
            required: isAnswerableType(type) ? src.required : false,
          }
          // Ширина и колонки вариантов переезжают, пока новый тип их несёт (смена
          // short_text→email не должна молча разваливать ряд); вне whitelist они
          // роняются здесь — иначе автосейв ловил бы 422 (нормализация добьёт пару).
          carryLayout(src, converted)
          return structural({
            blocks: s.blocks.map((b) => (b.id === id ? converted : b)),
          })
        })
        return id
      },

      makeQuestion: (id, type) => {
        let focus = id
        commit(null, (s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          const src = s.blocks[i]
          if (!src) return null
          const [gStart, gEnd] = groupSpan(s.blocks, i)
          const field: Block = { ...newFieldBlock(type), text: '' }
          if (gStart === gEnd) {
            // Одиночный блок (своя группа) → он становится подписью, поле под ним.
            // Фокус на подпись (у неё textarea, автор правит текст вопроса дальше).
            const title: Block = { ...src, type: 'title', settings: {}, required: false }
            focus = title.id
            // Бит ряда переезжает на НОВОЕ поле (носитель бита — отвечаемый блок, а
            // подпись его не несёт): «дать вопросу подпись» не должно разваливать ряд.
            // Тот же carryLayout, что у makeField и changeBlockType — иначе два пункта
            // одного меню («Вопросы» и «Отдельные поля») вели бы себя противоположно.
            carryLayout(src, field)
            const blocks = s.blocks.slice()
            blocks.splice(i, 1, title, field)
            return structural({ blocks })
          }
          // Блок ВНУТРИ группы → новый вопрос НИЖЕ группы: инпут не встраивается между
          // подписью и контролом, а начинает новую группу. Текущий блок — контент.
          const title = newBlock('title')
          focus = title.id
          const blocks = s.blocks.slice()
          blocks.splice(gEnd + 1, 0, title, field)
          return structural({ blocks })
        })
        return focus
      },

      makeField: (id, type) => {
        let focus = id
        commit(null, (s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          const src = s.blocks[i]
          if (!src) return null
          const [gStart, gEnd] = groupSpan(s.blocks, i)
          if (gStart === gEnd) {
            // Одиночный блок → конверсия на месте в голое поле (текст роняется — у
            // поля его нет). Тот же путь, что changeBlockType на отвечаемый тип;
            // ширина/колонки переезжают по тому же правилу (carryLayout).
            const field: Block = { ...newFieldBlock(type), id }
            carryLayout(src, field)
            return structural({
              blocks: s.blocks.map((b) => (b.id === id ? field : b)),
            })
          }
          // Внутри группы → голое поле новой группой ниже; текущий блок остаётся.
          const field = newFieldBlock(type)
          focus = field.id
          const blocks = s.blocks.slice()
          blocks.splice(gEnd + 1, 0, field)
          return structural({ blocks })
        })
        return focus
      },

      addQuestionAfter: (afterId, type) => {
        const title = newBlock('title')
        const field = newFieldBlock(type)
        commit(null, (s) => {
          const at = groupEndAfter(s.blocks, afterId)
          const blocks = s.blocks.slice()
          blocks.splice(at, 0, title, field)
          return structural({ blocks })
        })
        return title.id
      },

      addFieldAfter: (afterId, type) => {
        const field = newFieldBlock(type)
        commit(null, (s) => {
          const at = groupEndAfter(s.blocks, afterId)
          const blocks = s.blocks.slice()
          blocks.splice(at, 0, field)
          return structural({ blocks })
        })
        return field.id
      },

      updateBlock: (id, patch) =>
        commit(updateBlockTag(id, patch), (s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          const src = s.blocks[i]
          // Блока нет — правку не к чему применить, и это не редкость: сюда
          // приходит отложенный колбэк, переживший свой блок (загрузка картинки
          // завершилась после того, как автора удалил блок). Прежде такой вызов
          // всё равно проходил через commit — `blocks.map` возвращает новый массив
          // даже когда ни один блок не совпал, — и давал шаг истории, в котором
          // ничего не меняется (Ctrl+Z «съедал» нажатие), dirty и лишний PATCH.
          if (!src) return null
          // Патч ничего не меняет — тот же no-op. Сравниваем по ссылке: text и
          // required примитивны, а settings приходит новым объектом только тогда,
          // когда его действительно пересобрали.
          const keys = Object.keys(patch) as (keyof BlockPatch)[]
          if (keys.every((k) => Object.is(src[k], patch[k]))) return null
          const blocks = s.blocks.slice()
          blocks[i] = { ...src, ...patch }
          return { blocks }
        }),

      removeBlock: (id) =>
        commit(null, (s) => structural({ blocks: s.blocks.filter((b) => b.id !== id) })),

      removeGroup: (id) =>
        commit(null, (s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          if (i < 0) return null
          const [gStart, gEnd] = groupSpan(s.blocks, i)
          const removed = new Set(s.blocks.slice(gStart, gEnd + 1).map((b) => b.id))
          return structural({
            blocks: s.blocks.filter((b) => !removed.has(b.id)),
          })
        }),

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
          return structural({ blocks })
        }),

      moveGroup: (id, dir) =>
        commit(null, (s) => {
          // Группы смежны (regroup), поэтому достаточно разложить полотно на группы
          // общим groupBlocks и поменять текущую с соседней. То же, что reorderGroups,
          // но на один шаг вверх/вниз (Alt+Shift+стрелки), а не в позицию дропа.
          const cur = s.blocks.find((b) => b.id === id)
          if (!cur) return null
          const groups = groupBlocks(s.blocks)
          const gi = groups.findIndex((g) => g.id === cur.groupId)
          const gj = dir === 'up' ? gi - 1 : gi + 1
          if (gj < 0 || gj >= groups.length) return null // группа на границе — no-op
          const tmp = groups[gi]!
          groups[gi] = groups[gj]!
          groups[gj] = tmp
          return structural({ blocks: groups.flatMap((g) => g.blocks) })
        }),

      reorderBlocks: (activeId, overId) =>
        commit(null, (s) => {
          // Плоский перенос одной строки через planBlockDrop: arrayMove — как
          // sortable и показывает — плюс правило §4.4 (отвечаемый/подпись не
          // приземляются внутрь чужой мульти-группы, а уезжают под неё).
          // Принадлежность группам после переноса выводит regroup. Целостность
          // мульти-группы при переносе ЕЁ САМОЙ охраняет не этот метод, а UI:
          // подпись мульти-группы несёт групповую ручку → reorderGroups.
          const plan = planBlockDrop(s.blocks, activeId, overId)
          return plan && plan.changed ? structural({ blocks: plan.blocks }) : null
        }),

      reorderGroups: (activeGroupId, overGroupId) =>
        commit(null, (s) => {
          // Группы смежны (regroup), поэтому достаточно разложить полотно на группы,
          // переставить одну (arrayMove — как sortable и показывает) и склеить
          // обратно. Внутренний порядок блоков группы не меняется.
          if (activeGroupId === overGroupId) return null
          const groups = groupBlocks(s.blocks)
          const from = groups.findIndex((g) => g.id === activeGroupId)
          const to = groups.findIndex((g) => g.id === overGroupId)
          if (from < 0 || to < 0) return null
          const [moved] = groups.splice(from, 1)
          groups.splice(to, 0, moved!)
          return structural({ blocks: groups.flatMap((g) => g.blocks) })
        }),

      duplicateBlock: (id) =>
        commit(null, (s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          const src = s.blocks[i]
          if (!src) return null
          const copy: Block = { ...cloneBlock(src), id: newBlockId() }
          const blocks = s.blocks.slice()
          blocks.splice(i + 1, 0, copy)
          return structural({ blocks })
        }),

      placeInRow: (activeGroupId, targetGroupId) =>
        commit(null, (s) => {
          if (activeGroupId === targetGroupId) return null
          const active = groupAnswerable(s.blocks, activeGroupId)
          // Один и тот же путь для жеста и для Mod+Alt+→: клавиатура зовёт его с
          // предыдущей группой, и переезд вырождается в no-op сплайс.
          //
          // Отдельных правил «цель должна быть свободна от пары» и «в ряду максимум
          // двое» нет — есть два вопроса к раскладчику, который рисует ряды: свободна
          // ли ячейка ДО переезда (иначе новичок вытеснил бы из ряда третью группу, о
          // которой никто не просил) и приземлился ли флаг ПОСЛЕ (цель не умеет делить
          // ряд — normalizeColumns его снимет).
          if (!active || !canShareRow(active.type)) return null
          if (!rowHasFreeCell(s.blocks, targetGroupId)) return null
          const groups = groupBlocks(s.blocks)
          const from = groups.findIndex((g) => g.id === activeGroupId)
          if (from < 0 || !groups.some((g) => g.id === targetGroupId)) return null
          const [moved0] = groups.splice(from, 1)
          // Позицию цели ищем ПОСЛЕ выреза активной группы: до него индексы сдвинуты.
          groups.splice(groups.findIndex((g) => g.id === targetGroupId) + 1, 0, moved0!)
          const moved = structural(
            {
              blocks: groups
                .flatMap((g) => g.blocks)
                .map((b) =>
                  b.id === active.id ? { ...b, settings: { ...b.settings, column: COLUMN_RIGHT } } : b,
                ),
            },
            // Смена соседа здесь — по прямой просьбе, а не побочный эффект переноса.
            active.id,
          )!
          // Флаг не приземлился (цель не умеет делить ряд) — normalizeColumns его снял,
          // а «перенос вплотную за цель» без ряда не то, о чём просили: откатываем весь
          // патч, чтобы не мусорить в истории.
          const landed = groupAnswerable(moved.blocks, activeGroupId)
          return landed?.settings?.column === COLUMN_RIGHT ? moved : null
        }),

      takeOwnRow: (id) =>
        commit(null, (s) => {
          const src = s.blocks.find((b) => b.id === id)
          if (!src) return null
          const a = groupAnswerable(s.blocks, src.groupId)
          if (!a || a.settings?.column !== COLUMN_RIGHT) return null
          return structural({
            blocks: s.blocks.map((b) => (b.id === a.id ? withoutColumn(b) : b)),
          })
        }),

      placeOptionInRow: (blockId, activeOptionId, targetOptionId) =>
        commit(null, (s) =>
          mutateOptions(
            s.blocks,
            blockId,
            (opts) => {
            if (activeOptionId === targetOptionId) return opts
            const from = opts.findIndex((o) => o.id === activeOptionId)
            if (from < 0 || !opts.some((o) => o.id === targetOptionId)) return opts
            // Тот же вопрос к раскладчику, что у блока: занятую ячейку не отбираем.
            if (!optionRowHasFreeCell(opts, targetOptionId)) return opts
            const next = opts.slice()
            const [moved] = next.splice(from, 1)
              next.splice(next.findIndex((o) => o.id === targetOptionId) + 1, 0, {
                ...moved!,
                column: COLUMN_RIGHT,
              })
              return next
            },
            // Как у блока: этому варианту сосед меняется по просьбе.
            activeOptionId,
          ),
        ),

      takeOptionOwnRow: (blockId, optionId) =>
        commit(null, (s) =>
          mutateOptions(s.blocks, blockId, (opts) => {
            const i = opts.findIndex((o) => o.id === optionId)
            if (i < 0 || opts[i]!.column !== COLUMN_RIGHT) return opts
            const next = opts.slice()
            next[i] = optionWithoutColumn(opts[i]!)
            return next
          }),
        ),

      addOption: (blockId) =>
        commit(null, (s) =>
          mutateOptions(s.blocks, blockId, (opts) => [...opts, { id: newOptionId(), label: '' }]),
        ),

      addOptionAfter: (blockId, optionId) => {
        const opt: Option = { id: newOptionId(), label: '' }
        commit(null, (s) =>
          mutateOptions(s.blocks, blockId, (opts) => {
            const i = opts.findIndex((o) => o.id === optionId)
            if (i < 0) return opts // вариант не найден — тот же массив (no-op)
            const next = opts.slice()
            next.splice(i + 1, 0, opt)
            return next
          }),
        )
        return opt.id
      },

      updateOption: (blockId, optionId, label) =>
        commit(`uo:${blockId}:${optionId}`, (s) =>
          mutateOptions(s.blocks, blockId, (opts) =>
            opts.map((o) => (o.id === optionId ? { ...o, label } : o)),
          ),
        ),

      reorderOptions: (blockId, activeOptionId, overOptionId) =>
        commit(null, (s) =>
          mutateOptions(s.blocks, blockId, (opts) => {
            const from = opts.findIndex((o) => o.id === activeOptionId)
            const to = opts.findIndex((o) => o.id === overOptionId)
            if (from < 0 || to < 0 || from === to) return opts
            const next = opts.slice()
            const [moved] = next.splice(from, 1)
            next.splice(to, 0, moved!)
            return next
          }),
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

      setSubmitLabel: (label) => commit('sl', () => ({ submitLabel: label })),

      // Тег null: настройки прилетают готовым набором по кнопке, коалесить нечего.
      setAfterSubmit: ({ thankYouText, redirectUrl }) =>
        commit(null, (s) =>
          s.thankYouText === thankYouText && s.redirectUrl === redirectUrl
            ? null
            : { thankYouText, redirectUrl },
        ),

      undo: () => {
        let focus: string | null = null
        set((s) => {
          const prev = s.past[s.past.length - 1]
          if (!prev) return s
          focus = firstDiffFocus(s.blocks, prev.blocks)
          // Снапшот разворачивается целиком, а не по полю: перечисление руками —
          // это ровно тот способ, которым новое поле документа теряется в undo.
          return {
            ...prev,
            past: s.past.slice(0, -1),
            future: [...s.future, snapshot(s)],
            lastTag: null,
            dirty: true,
          }
        })
        return focus
      },

      redo: () => {
        let focus: string | null = null
        set((s) => {
          const next = s.future[s.future.length - 1]
          if (!next) return s
          focus = firstDiffFocus(s.blocks, next.blocks)
          return {
            ...next,
            past: [...s.past, snapshot(s)],
            future: s.future.slice(0, -1),
            lastTag: null,
            dirty: true,
          }
        })
        return focus
      },

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
