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
  supportsHalfWidth,
  supportsOptionColumns,
} from '@entities/formSchema'

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
  // pairWithPrevious ставит вопрос рядом с предыдущим (спека §5): отвечаемые обеих
  // групп получают width='half' и пакуются в один ряд. Условия — canPairWithPrevious;
  // иначе no-op. Один шаг undo на оба блока.
  pairWithPrevious: (id: string) => void
  // setFullWidth разворачивает вопрос на всю ширину: снимает width с отвечаемого
  // его группы; осиротевший сосед по ряду разворачивается сам (normalizeWidths).
  setFullWidth: (id: string) => void
  // placeGroupBeside — жест бокового дропа (спека §5): группа activeGroupId встаёт
  // вплотную before/after группы overGroupId, обе становятся half и пакуются в ряд.
  // Цель должна быть свободной whitelist-группой (не в паре); иначе no-op.
  placeGroupBeside: (activeGroupId: string, overGroupId: string, side: 'before' | 'after') => void
  // setOptionColumns — раскладка списка вариантов (спека §5.1): 2 — сетка в две
  // колонки, 1 — прежний стек (ключ снимается). Только single_choice/multi_choice.
  setOptionColumns: (blockId: string, cols: 1 | 2) => void
  // Редактор опций choice-блока. На non-choice и несуществующем блоке — no-op.
  addOption: (blockId: string) => void
  // addOptionAfter вставляет пустой вариант СРАЗУ ПОСЛЕ optionId (Enter §3.2: вариант
  // рождается под текущим, а не в конце — дефект Д5) и возвращает его id для фокуса.
  // На non-choice/ненайденном варианте — no-op (возвращённый id тогда не всплывёт).
  addOptionAfter: (blockId: string, optionId: string) => string
  updateOption: (blockId: string, optionId: string, label: string) => void
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

// carryLayout переносит лэйаут-свойства (width, optionColumns) со старого блока на
// сконвертированный, если новый тип их несёт; вне своих whitelist они молча
// роняются — чтобы автосейв не ловил 422 на невалидном сочетании (спека §5/§5.1).
// Мутирует dst (свежесозданный блок конверсии, ещё не в сторе).
function carryLayout(src: Block, dst: Block): void {
  if (src.settings?.width === 'half' && supportsHalfWidth(dst.type)) {
    dst.settings = { ...dst.settings, width: 'half' }
  }
  if (src.settings?.optionColumns === 2 && supportsOptionColumns(dst.type)) {
    dst.settings = { ...dst.settings, optionColumns: 2 }
  }
}

// withoutWidth снимает half-ширину с блока (канон хранит только отклонение —
// ключ просто удаляется). Возвращает тот же объект, если снимать нечего.
function withoutWidth(b: Block): Block {
  if (b.settings?.width === undefined) return b
  const settings = { ...b.settings }
  delete settings.width
  return { ...b, settings }
}

// normalizeWidths держит инвариант спеки §5 «одинокая половина возвращается на
// full»: half-группы живут только смежными ПАРАМИ (слева направо, как packRows),
// у непарной половины ширина снимается. Прогоняется после каждой структурной
// правки (structural) — сосед уехал/удалён/сменил тип, и вдовец сам разворачивается
// во всю ширину; дыры в полряда на полотне не бывает. Возвращает исходный массив,
// если снимать нечего (сохраняет дешёвые no-op коммиты).
function normalizeWidths(blocks: Block[]): Block[] {
  // Половину несёт отвечаемый блок группы; группы смежны (regroup), поэтому
  // достаточно пройти по границам groupId и спарить соседние half-группы.
  const clear = new Set<string>()
  let pending: string | null = null // id отвечаемого half-группы, ждущей пару
  let gid: string | null = null
  let half: string | null = null // отвечаемый с width='half' текущей группы
  const flush = () => {
    if (half) {
      if (pending) pending = null // пара сложилась
      else pending = half
    } else if (pending) {
      clear.add(pending)
      pending = null
    }
  }
  for (const b of blocks) {
    if (b.groupId !== gid) {
      if (gid !== null) flush()
      gid = b.groupId
      half = null
    }
    if (isAnswerableType(b.type) && b.settings?.width === 'half') half = b.id
  }
  if (gid !== null) flush()
  if (pending) clear.add(pending)
  if (clear.size === 0) return blocks
  return blocks.map((b) => (clear.has(b.id) ? withoutWidth(b) : b))
}

// groupAnswerable — отвечаемый блок группы gid (носитель width) или null.
function groupAnswerable(blocks: Block[], gid: string): Block | null {
  return blocks.find((b) => b.groupId === gid && isAnswerableType(b.type)) ?? null
}

// canPairWithPrevious — доступен ли жест «поставить рядом с предыдущим» для блока
// id: обе группы (текущая и предыдущая) несут whitelist-отвечаемые, и предыдущая
// ещё не в паре (half-группы нормализованы, поэтому «предыдущая half» = «уже в
// паре» — третьему в ряду места нет). Читается Cmd+.-меню для видимости пункта,
// та же проверка стоит в pairWithPrevious.
export function canPairWithPrevious(blocks: Block[], id: string): boolean {
  const i = blocks.findIndex((b) => b.id === id)
  if (i < 0) return false
  const gid = blocks[i]!.groupId
  const [gStart] = groupSpan(blocks, i)
  if (gStart === 0) return false // первая группа — рядом ставить не с кем
  const prevGid = blocks[gStart - 1]!.groupId
  const cur = groupAnswerable(blocks, gid)
  const prev = groupAnswerable(blocks, prevGid)
  return (
    cur !== null &&
    prev !== null &&
    supportsHalfWidth(cur.type) &&
    supportsHalfWidth(prev.type) &&
    prev.settings?.width !== 'half' &&
    cur.settings?.width !== 'half'
  )
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
    // через regroup, чтобы groupId всегда отражал раскладку, и normalizeWidths,
    // чтобы half-группы жили только парами (одинокая половина → full, спека §5).
    function structural(patch: (Partial<BuilderState> & { blocks: Block[] }) | null) {
      if (patch === null) return null
      return { ...patch, blocks: normalizeWidths(regroup(patch.blocks)) }
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
          // normalizeWidths и здесь: контракт формально допускает одинокую половину,
          // а редактор с ней не работает — приводим при загрузке (dirty не ставится,
          // на сервер уедет со следующей правкой).
          blocks: normalizeWidths(regroup(schema.blocks.map(cloneBlock))),
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
        commit(updateBlockTag(id, patch), (s) => ({
          blocks: s.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
        })),

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
          // Собираем порядок групп с их блоками (группы смежны — regroup) и меняем
          // текущую группу местами с соседней. То же построение, что reorderGroups,
          // но на один шаг вверх/вниз (Alt+Shift+стрелки), а не в позицию дропа.
          const cur = s.blocks.find((b) => b.id === id)
          if (!cur) return null
          const order: string[] = []
          const byGroup = new Map<string, Block[]>()
          for (const b of s.blocks) {
            const g = byGroup.get(b.groupId)
            if (g) g.push(b)
            else {
              byGroup.set(b.groupId, [b])
              order.push(b.groupId)
            }
          }
          const gi = order.indexOf(cur.groupId)
          const gj = dir === 'up' ? gi - 1 : gi + 1
          if (gj < 0 || gj >= order.length) return null // группа на границе — no-op
          const tmp = order[gi]!
          order[gi] = order[gj]!
          order[gj] = tmp
          return structural({ blocks: order.flatMap((g) => byGroup.get(g)!) })
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
          // Группы смежны (regroup), поэтому достаточно собрать порядок групп с их
          // блоками, переставить группу (arrayMove — как sortable и показывает) и
          // склеить обратно. Внутренний порядок блоков группы не меняется.
          if (activeGroupId === overGroupId) return null
          const order: string[] = []
          const byGroup = new Map<string, Block[]>()
          for (const b of s.blocks) {
            const g = byGroup.get(b.groupId)
            if (g) g.push(b)
            else {
              byGroup.set(b.groupId, [b])
              order.push(b.groupId)
            }
          }
          const from = order.indexOf(activeGroupId)
          const to = order.indexOf(overGroupId)
          if (from < 0 || to < 0) return null
          const [moved] = order.splice(from, 1)
          order.splice(to, 0, moved!)
          return structural({ blocks: order.flatMap((g) => byGroup.get(g)!) })
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

      pairWithPrevious: (id) =>
        commit(null, (s) => {
          if (!canPairWithPrevious(s.blocks, id)) return null
          const i = s.blocks.findIndex((b) => b.id === id)
          const [gStart] = groupSpan(s.blocks, i)
          const cur = groupAnswerable(s.blocks, s.blocks[i]!.groupId)!
          const prev = groupAnswerable(s.blocks, s.blocks[gStart - 1]!.groupId)!
          const half = new Set([cur.id, prev.id])
          return structural({
            blocks: s.blocks.map((b) =>
              half.has(b.id) ? { ...b, settings: { ...b.settings, width: 'half' } } : b,
            ),
          })
        }),

      setFullWidth: (id) =>
        commit(null, (s) => {
          const src = s.blocks.find((b) => b.id === id)
          if (!src) return null
          const a = groupAnswerable(s.blocks, src.groupId)
          if (!a || a.settings?.width !== 'half') return null
          return structural({
            blocks: s.blocks.map((b) => (b.id === a.id ? withoutWidth(b) : b)),
          })
        }),

      placeGroupBeside: (activeGroupId, overGroupId, side) =>
        commit(null, (s) => {
          if (activeGroupId === overGroupId) return null
          const active = groupAnswerable(s.blocks, activeGroupId)
          const over = groupAnswerable(s.blocks, overGroupId)
          // Оба конца жеста — whitelist-отвечаемые; цель не в паре (в ряду максимум
          // двое — третий легально приземляется только под рядом, обычным дропом).
          if (
            !active ||
            !over ||
            !supportsHalfWidth(active.type) ||
            !supportsHalfWidth(over.type) ||
            over.settings?.width === 'half'
          )
            return null
          const order: string[] = []
          const byGroup = new Map<string, Block[]>()
          for (const b of s.blocks) {
            const g = byGroup.get(b.groupId)
            if (g) g.push(b)
            else {
              byGroup.set(b.groupId, [b])
              order.push(b.groupId)
            }
          }
          const from = order.indexOf(activeGroupId)
          if (from < 0 || !order.includes(overGroupId)) return null
          order.splice(from, 1)
          const at = order.indexOf(overGroupId) + (side === 'after' ? 1 : 0)
          order.splice(at, 0, activeGroupId)
          const half = new Set([active.id, over.id])
          return structural({
            blocks: order
              .flatMap((g) => byGroup.get(g)!)
              .map((b) => (half.has(b.id) ? { ...b, settings: { ...b.settings, width: 'half' } } : b)),
          })
        }),

      setOptionColumns: (blockId, cols) =>
        commit(null, (s) => {
          const src = s.blocks.find((b) => b.id === blockId)
          if (!src || !supportsOptionColumns(src.type)) return null
          const current = src.settings?.optionColumns === 2 ? 2 : 1
          if (current === cols) return null
          const settings = { ...src.settings }
          if (cols === 2) settings.optionColumns = 2
          else delete settings.optionColumns
          return { blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, settings } : b)) }
        }),

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
