import { createStore, type StoreApi } from 'zustand/vanilla'

import {
  type Block,
  type BlockType,
  type FormCover,
  type FormLogo,
  type FormSchema,
  type Option,
  SCHEMA_VERSION,
  isChoiceType,
  isAnswerableType,
  isCaptionType,
  carriesText,
  canShareRow,
  requiresCaption,
  supportsPlaceholder,
  COLUMN_LEFT,
  COLUMN_RIGHT,
  sameRichText,
} from '@entities/formSchema'
import {
  groupBlocks,
  groupCanShareRow,
  groupMeta,
  packGroupRows,
  packOptionRows,
  packRows,
} from '@fields/groups'
import { editorKind } from './kinds/index'

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
export type BlockPatch = Partial<Pick<Block, 'text' | 'name' | 'required' | 'settings'>>

// Чем вызвана правка — знает только вызывающий, и стору это нужно ровно для одного:
// как класть её в историю (см. updateBlockTag). 'format' — команда панели или аккорд
// форматирования; отсутствие — обычный набор.
export type UpdateKind = 'format'

// Snapshot — снимок документа (blocks + поля формы-уровня) для стеков undo/redo.
// dirty — производный UI, в снапшот не входит. Фокус — не стейт стора (живёт в
// фокус-движке полотна, §2.5), поэтому откат его не касается. Новое поле документа
// обязано попасть сюда, иначе undo его молча потеряет.
export type Snapshot = {
  blocks: Block[]
  submitLabel: string
  thankYouText: string
  redirectUrl: string
  cover: FormCover | undefined
  logo: FormLogo | undefined
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
  // Оформление страницы (форма-уровень): обложка цветом или картинкой и логотип.
  // undefined = «не задано», и это единственный способ сказать «обложки нет» —
  // пустого объекта в схеме не бывает (ADR §10).
  cover: FormCover | undefined
  logo: FormLogo | undefined
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
  // месте в голое поле; блок внутри группы → голое поле новой группой ниже; ОДИНОКАЯ
  // ПОДПИСЬ → поле под ней, в её группу (текст заголовка цел). Тип из requiresCaption
  // голым не встаёт: везде, кроме одинокой подписи, жест вырождается в makeQuestion.
  makeField: (id: string, type: BlockType) => string
  // addQuestionAfter вставляет вопрос-бандл (подпись title + поле) ПОСЛЕ всей группы
  // afterId (инпут начинает новую группу). Диалог «+», раздел «Вопросы».
  addQuestionAfter: (afterId: string | null, type: BlockType) => string
  // addFieldAfter вставляет голое поле ПОСЛЕ всей группы afterId. Диалог «+», раздел
  // «Отдельные поля». Тип из requiresCaption получает свой заголовок, если приземлился
  // не под ждущей подписью; возвращается id для каретки — заголовка либо поля.
  addFieldAfter: (afterId: string | null, type: BlockType) => string
  // addCaptionFor даёт голой строке ответа заголовок: пустая подпись title встаёт
  // ПРЯМО НАД полем и regroup склеивает их в вопрос (фаза 15, §4.4 спеки). Обратный
  // жест к makeField «подсадить поле к ждущей подписи» — тот же вопрос, собранный с
  // другого конца. Возвращает id новой подписи для каретки; null — строке заголовок
  // не нужен (не отвечаемая, несёт свой текст, подпись уже есть) или блока нет.
  addCaptionFor: (id: string) => string | null
  updateBlock: (id: string, patch: BlockPatch, kind?: UpdateKind) => void
  removeBlock: (id: string) => void
  // removeGroup удаляет всю группу блока (подпись владеет группой): trash по подписи
  // сносит подпись + контент + поле. На несуществующем блоке — no-op.
  removeGroup: (id: string) => void
  // moveBlock двигает блок на одну позицию; на границе списка — no-op (dirty не
  // трогает). На ПОДПИСИ вопроса двигает всю группу (подпись — ручка вопроса).
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
  // duplicateBlock кладёт копию блока сразу за оригиналом. Поле, которому обязателен
  // заголовок (requiresCaption), дублируется вопросом целиком — иначе копия осталась
  // бы голым полем такого типа, а их не бывает.
  // duplicateBlock вставляет копию сразу за оригиналом и ВОЗВРАЩАЕТ id её первой
  // строки — для каретки (§12). Подпись собранного вопроса и поле, которому обязателен
  // заголовок, дублируются вопросом целиком; остальное — по одному блоку.
  duplicateBlock: (id: string) => string | null
  // placeInRow — команда ПЕРЕНОСА в свободную ячейку ряда (спека §5), единственный
  // вход и для жеста (дроп в левую/правую треть ряда), и для Mod+Alt+→: группа
  // activeGroupId встаёт вплотную к targetGroupId с указанной стороны. Не режим и не
  // тумблер. Бит всегда несёт ПРАВЫЙ участник, поэтому side решает лишь, кто им
  // станет — активная группа (right) или сама цель (left). Ряд цели полон / пара не
  // сложилась → флаг инертен, и вся команда откатывается (no-op, историю и dirty не
  // трогает).
  placeInRow: (activeGroupId: string, targetGroupId: string, side?: 'left' | 'right') => void
  // placeBlockInRow — та же команда переноса на ВТОРОМ уровне (фаза 15, §6.6): поле
  // встаёт в ряд со своей подписью внутри вопроса. Пара обязана быть «подпись +
  // короткое поле» из одной группы, ячейка подписи — свободной; иначе no-op.
  placeBlockInRow: (activeBlockId: string, targetBlockId: string) => void
  // takeOwnRow — обратная команда (Mod+Alt+←, обычный вертикальный дроп): элемент
  // возвращается своим рядом. Какой именно — решает место строки в группе: своя
  // строка выходит из ряда внутри вопроса, голова уводит из ряда весь вопрос.
  //
  // Секция при этом остаётся ЦЕЛОЙ, если в колонке ушедшего был кто-то ещё: вопрос
  // уезжает ПОД неё (полноширинный блок внутри секции разрезал бы её пополам, §11.3).
  // Опустела колонка — секции не остаётся вовсе, и биты снимаются со всех её
  // участников: иначе остаток приклеится к следующей секции ниже.
  takeOwnRow: (id: string) => void
  // shiftColumn — ШАГ ПО ОСИ КОЛОНОК (§11.6): полная ширина ↔ левая колонка ↔ правая.
  // Один вход для Mod+Alt+→ и Mod+Alt+←; чем шаг обернётся, зависит от того, где
  // элемент стоит сейчас (rowPosition), а не от режима, который где-то хранится.
  // Крайняя позиция оси в свою сторону — no-op.
  shiftColumn: (id: string, dir: 'left' | 'right') => void
  // Те же две команды для варианта (спека §5.1: различий с блоками нет ни одного).
  placeOptionInRow: (blockId: string, activeOptionId: string, targetOptionId: string) => void
  takeOptionOwnRow: (blockId: string, optionId: string) => void
  // Редактор опций choice-блока. На non-choice и несуществующем блоке — no-op.
  // addOption добавляет вариант в конец и возвращает его id (нужен фокусу): пустой —
  // кнопкой/жестом, с текстом — первым символом, набранным в «призраке» списка.
  addOption: (blockId: string, label?: string) => string
  // addOptionAfter вставляет пустой вариант СРАЗУ ПОСЛЕ optionId (Enter §3.2: вариант
  // рождается под текущим, а не в конце — дефект Д5) и возвращает его id для фокуса.
  // На non-choice/ненайденном варианте — no-op (возвращённый id тогда не всплывёт).
  addOptionAfter: (blockId: string, optionId: string) => string
  // duplicateOption копирует вариант СРАЗУ ПОД оригиналом и возвращает id копии для
  // каретки (§12). Единственный вход — попап варианта (фаза 16, решение 7): у карточки
  // это второе действие рядом с «удалить».
  duplicateOption: (blockId: string, optionId: string) => string | null
  updateOption: (blockId: string, optionId: string, label: string) => void
  // reorderOptions переносит вариант activeOptionId на позицию overOptionId (dnd
  // вариантов, спека §5.1) — сплайс, как reorderBlocks. Незнакомые id — no-op.
  reorderOptions: (blockId: string, activeOptionId: string, overOptionId: string) => void
  // removeOption удаляет вариант. Последний вариант уносит с собой сам блок (choice
  // без вариантов не существует) — остаётся подпись группы; это один шаг истории.
  removeOption: (blockId: string, optionId: string) => void
  moveOption: (blockId: string, optionId: string, dir: 'up' | 'down') => void
  // setSubmitLabel меняет текст кнопки отправки (форма-уровень).
  setSubmitLabel: (label: string) => void
  // setAfterSubmit применяет настройки экрана «после отправки» целиком. Одним
  // действием, а не полем за полем: страница настроек сохраняется по кнопке, и
  // нажатие обязано быть одним шагом отмены. Никаких правок — no-op (историю и
  // dirty не трогает).
  setAfterSubmit: (settings: { thankYouText: string; redirectUrl: string }) => void
  // setCover/setLogo применяют оформление страницы целиком; undefined снимает его.
  // Обложка ставится ОДНИМ значением (цвет или картинка), а не двумя полями: контракт
  // не знает состояния «и то, и другое», и стор не должен уметь его выразить даже на
  // мгновение — иначе автосейв поймает 422 посреди жеста.
  setCover: (cover: FormCover | undefined) => void
  setLogo: (logo: FormLogo | undefined) => void
  // setCoverY двигает точку фокуса картинки. Свой тег коалесинга: жест перетаскивания
  // коммитится один раз на отпускании, но повторные жесты подряд остаются разными
  // шагами истории — как набор в одно поле против набора в разные.
  setCoverY: (y: number) => void
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

// newBlock создаёт валидный черновой блок: скелет (пустой text, выведенный позже
// groupId, пустые настройки) плюс дефолты своего типа — они объявлены в файле типа
// (kinds/<type>.tsx, поле defaults), а не перечислены здесь ветвями.
//
// Скелет остаётся с ПУСТЫМИ settings: тип, которому нечего в них положить, обязан
// приехать без чужих ключей, иначе ValidateSchema отвергнет документ (опции у не-choice).
// Слияние поверхностное — settings типа заменяют пустые целиком, вложенного мержа тут не
// нужно и не должно быть: «дефолты» это готовый набор, а не патч.
//
// Дефолты КЛОНИРУЮТСЯ, а не спредятся ссылкой (находка ревью этапа 16.1в). Поверхностный
// спред копирует ссылку на settings типа — литерал уровня модуля, живущий весь срок
// вкладки: все блоки типа получали ОДИН объект настроек и один массив options на всех.
// Сегодня это ничего не ломает (весь стор пишет настройки иммутабельно, присваивая новый
// объект), но цена первой же правки «на месте» — испорченный ДЕФОЛТ ТИПА: следующий
// новый блок приедет с чужими вариантами внутри, и отвергнет документ уже ValidateSchema,
// далеко от места ошибки. Клон стоит наносекунды и снимает весь класс.
function newBlock(type: BlockType): Block {
  const base: Block = {
    id: newBlockId(),
    groupId: '', // проставит regroup
    type,
    text: [],
    required: false,
    settings: {},
  }
  const defaults = editorKind(type).defaults
  return { ...base, ...(defaults ? structuredClone(defaults) : null) }
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
// вопрос не входит никогда (раздел — не подпись поля). ЗАГОЛОВОК ФОРМЫ (form_title,
// фаза 15) спецслучая здесь не требует: он не подпись и не мостовой контент
// (text/image), поэтому ни одна из двух веток его не подберёт — он остаётся
// одиночкой по построению, чего и требует инвариант схемы. Инварианты v2 держатся:
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
      // Подпись ровно ОДНА — ближайшая к полю (решение владельца 2026-07-26).
      // Собранная группа «подпись + поле» целая, второй заголовок в неё не входит:
      // подписи выше остаются одиночками. Раньше группа забирала все подряд идущие
      // подписи («title над label»), и осиротевшая подпись мёртвого вопроса,
      // оказавшись вплотную над следующим, молча становилась ЕГО вторым заголовком —
      // а первый непустой title перебивал настоящий в CSV и воронке.
      for (let k = j; k <= i; k++) anchor[k] = b.id
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

// carryLayout переносит бит ряда со старого блока на сконвертированный. Проверка
// «умеет ли новый тип делить ряд» осталась одна и вырожденная (всё, кроме заголовка
// формы, — ADR §10), но остаётся здесь, а не выпиливается: она отвечает не за вид, а
// за валидность документа, и автосейв ловил бы 422 на невалидном сочетании. Мутирует
// dst (свежесозданный блок конверсии, ещё не в сторе).
function carryLayout(src: Block, dst: Block): void {
  if (src.settings?.column === COLUMN_RIGHT && canShareRow(dst.type)) {
    dst.settings = { ...dst.settings, column: COLUMN_RIGHT }
  }
}

// carryPlaceholder переносит подсказку поля на сконвертированный блок, пока новый тип
// её несёт (§5.4 спеки фазы 16). До этапа 16.4 плейсхолдер терялся даже на
// short_text → email, хотя оба типа его показывают: автор менял тип соседнего поля и
// молча лишался написанной подсказки. Условие — тот же предикат реестра, что решает,
// показывать ли поверхность плейсхолдера, поэтому «тип, который его не носит»
// невозможен по построению. Мутирует dst (как carryLayout).
function carryPlaceholder(src: Block, dst: Block): void {
  const placeholder = src.settings?.placeholder
  if (placeholder && supportsPlaceholder(dst.type)) {
    dst.settings = { ...dst.settings, placeholder }
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

// rowGroups — группы, участвующие в РЯДАХ: документ без заголовка формы. Он рисуется
// вне потока вопросов (splitFormTitle на всех трёх поверхностях), поэтому и колонку
// делить не может — ADR §10 говорит это же прямым текстом («кроме заголовка формы»).
//
// Читать документ иначе, чем читает рендерер, стор не имеет права дважды: во-первых,
// редактор собрал бы ряд «заголовок | первый вопрос», которого не показала бы ни одна
// другая поверхность; во-вторых, канон пометил бы заголовок битом 'left' — а такого
// документа схема не принимает (Zod и Go проверяют canShareRow), и автор получил бы
// «ошибку сохранения» на форму, которую он даже не правил. Именно так и было: бит у
// первого вопроса приезжает из старой формы, где он был инертен.
//
// Группа заголовка — всегда ровно один блок: regroup ведёт группу от поля вверх через
// text/image до подписи, а form_title ни то ни другое.
function rowGroups(blocks: Block[]): { id: string; blocks: Block[] }[] {
  return groupBlocks(blocks).filter((g) => g.blocks[0]!.type !== 'form_title')
}

// sectionMates — для каждого элемента, стоящего В СЕКЦИИ: id блоков ОСТАЛЬНЫХ её
// участников. Ключ — id блока, а не groupId: groupId выводится regroup и может
// смениться от чужой правки, id блока стабилен (на него же ссылаются answers).
//
// Обходит оба уровня (§11.5, §6.2): секции из групп и ряды «подпись | поле» внутри
// группы. Отсюда следуют ОБА правила уборки, и своего у стора нет ни одного:
//
//   • «бит инертен» = элемента нет в карте вовсе (раскладчик бит не применил);
//   • «секция сменилась» = от прежней компании не осталось НИКОГО.
//
// Компания, а не «конкретный сосед» и не ключ секции: она устойчива к тому, к чему
// обязана быть устойчива. Перестановка внутри секции компанию не меняет (те же лица);
// приход нового участника не меняет её для остальных; а вот полноширинный блок,
// вставленный в середину секции, разрывает её так, что у нижней части от прежней
// компании не остаётся никого — и биты снимаются, как и раньше. Ключ по первому
// элементу левой колонки этого не умел: перестановка самого первого элемента меняла
// ключ и разваливала секцию.
function sectionMates(blocks: Block[]): Map<string, Set<string>> {
  const mates = new Map<string, Set<string>>()
  const add = (participants: Block[][]) => {
    const ids = participants.map((p) => p.map((b) => b.id))
    ids.forEach((own, i) => {
      const others = new Set(ids.filter((_, j) => j !== i).flat())
      for (const id of own) mates.set(id, others)
    })
  }
  const groups = rowGroups(blocks)
  for (const row of packRows(groups)) {
    if (row.length < 2) continue // не секция — полная ширина
    add(row.flat().map((g) => g.blocks))
  }
  for (const g of groups) {
    for (const row of packGroupRows(g.blocks)) {
      if (row.length < 2) continue
      add(row.flat().map((b) => [b]))
    }
  }
  return mates
}

// То же для вариантов: сосед варианта — предыдущий вариант его ряда.
function optionPartners(options: Option[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const [leftCell, rightCell] of packOptionRows(options)) {
    if (!rightCell) continue
    let neighbor = leftCell![0]!.id
    for (const o of rightCell) {
      m.set(o.id, neighbor)
      neighbor = o.id
    }
  }
  return m
}

// reanchorRowBits — бит, который БЫЛ кросс-групповым, остаётся кросс-групповым, даже
// если правка увела его блок с головы группы (v4, §6.3: смысл ключа задаёт место).
//
// Случай, ради которого это существует: голое поле стоит в ряду со своим соседом, и
// автор даёт ему заголовок (Mod+Alt+T). Подпись становится головой группы, поле —
// вторым блоком, и тот же ключ на нём начинает значить «встань справа от своей
// подписи». Без пере-якорения вопрос молча выпрыгнул бы из ряда и перестроился
// внутрь себя — правка заголовка переставила бы форму.
//
// Обратный случай (бит был внутригрупповым, блок стал головой — например, подпись
// удалили) специально НЕ переносится: партнёр, ради которого бит ставили, исчез, и
// дальше его судьбу решает обычная проверка инертности/смены соседа.
//
// **Переезжает бит только внутри СВОЕГО вопроса.** Условие «блок был головой, а стал не
// головой» выполняется ещё в одном случае, для которого правило не писалось: блок
// вертикальным дропом уехал ВНУТРЬ чужого вопроса (§4.1, дроп туда разрешён с фазы 15).
// Тогда бит доставался голове чужой группы, и та «вставала справа от предыдущей» —
// вертикальный дроп РОЖДАЛ ряд, которого никто не просил, вместо того чтобы бит снять
// (§13, «обычный вертикальный дроп бит снимает»). Владелец видел это как склеивание
// блоков вокруг ряда, 2026-08-03. Отличаются случаи головой: у `Mod+Alt+T`/makeQuestion
// подпись СОЗДАЁТСЯ, её id в прежнем документе нет; у переезда в чужой вопрос голова —
// давно живущий блок другой группы. Бит там не переезжает и не остаётся: он умирает
// вместе с рядом, из которого блок унесли.
function reanchorRowBits(blocks: Block[], prev?: Block[]): Block[] {
  if (!prev) return blocks
  const wasHead = new Set(groupBlocks(prev).map((g) => g.blocks[0]!.id))
  const wasGroup = new Map(prev.map((b) => [b.id, b.groupId]))
  const move = new Map<string, string>() // носитель → голова, на которую переезжает бит
  const drop = new Set<string>() // носитель, чей бит умирает: вопрос теперь чужой
  for (const g of groupBlocks(blocks)) {
    const head = g.blocks[0]!
    for (const b of g.blocks.slice(1)) {
      if (b.settings?.column !== COLUMN_RIGHT || !wasHead.has(b.id)) continue
      const headWas = wasGroup.get(head.id)
      if (headWas === undefined || headWas === wasGroup.get(b.id)) move.set(b.id, head.id)
      else drop.add(b.id)
    }
  }
  if (move.size === 0 && drop.size === 0) return blocks
  const heads = new Set(move.values())
  return blocks.map((b) => {
    if (move.has(b.id) || drop.has(b.id)) return withoutColumn(b)
    // У головы бит уже мог быть свой — тогда переезжающий просто пропадает.
    if (heads.has(b.id) && b.settings?.column !== COLUMN_RIGHT) {
      return { ...b, settings: { ...b.settings, column: COLUMN_RIGHT } }
    }
    return b
  })
}

// normalizeSections приводит документ к КАНОНУ секции (спека §11.4). Две правки, обе
// выводимые из раскладки — как groupId выводится regroup:
//
//  1. ЯВНАЯ ЛЕВАЯ КОЛОНКА. Элементу левой колонки, чей бит НЕ 'left', ставится 'left' —
//     и когда бита нет, и когда там 'right'. Иначе левая колонка ломается на втором
//     элементе: у неявной формы («'right' забрал предыдущего») открывший секцию несёт
//     чужой бит или не несёт никакого, и вставка второго элемента в левую колонку давала
//     бы документ, где открывший её ЗАКРЫВАЕТ секцию и уезжает из неё. Неявная форма
//     остаётся читаемой (старые формы, промежуточный результат жеста), но не хранимой.
//     Случай «в левой колонке лежит 'right'» даёт переезд между колонками: ушедший
//     оставляет колонку пустой, и раскладчик забирает в неё первого из уцелевшей — с его
//     прежним битом (найдено ревью этапа 15.6).
//  2. КОЛОНОЧНЫЙ ПОРЯДОК. Внутри секции сперва вся левая колонка, потом вся правая.
//     Иначе порядок DOM — а с ним Tab, скринридер и колонки CSV — скакал бы между
//     колонками. Плата названа в спеке: перенос между колонками двигает элемент в
//     документе, то есть меняет порядок колонок в выгрузке; автор видит это глазами, а
//     Mod+Z откатывает.
//
// Секция — непрерывный пробег групп (автомат раскладчика идёт по потоку), поэтому
// перестановка внутри неё блоки групп не разрывает. Идемпотентна: канон в себя же и
// переходит. Возвращает исходный массив, если править нечего.
function normalizeSections(blocks: Block[]): Block[] {
  const all = groupBlocks(blocks)
  const groups = rowGroups(blocks)
  const stamp = new Set<string>() // головы групп левой колонки с неканоническим битом
  const order: string[] = [] // groupId в каноническом порядке
  let moved = false
  for (const row of packRows(groups)) {
    if (row.length < 2) {
      order.push(...row.flat().map((g) => g.id))
      continue
    }
    const [leftCell, rightCell] = row
    for (const g of leftCell!) {
      if (g.blocks[0]!.settings?.column !== COLUMN_LEFT) stamp.add(g.blocks[0]!.id)
    }
    const canonical = [...leftCell!, ...rightCell!].map((g) => g.id)
    const asIs = row.flat().map((g) => g.id)
    if (canonical.some((id, i) => id !== asIs[i])) moved = true
    order.push(...canonical)
  }
  if (stamp.size === 0 && !moved) return blocks
  const byId = new Map(groups.map((g) => [g.id, g]))
  // Склейка идёт по ПОЛНОМУ списку групп: заголовок формы в рядах не участвует (его тут
  // и нет в order), но и с места не двигается — на своём месте он остаётся тем же
  // блоком, а канон переставляет только группы внутри секции.
  let k = 0
  const next = all.flatMap((g) => (byId.has(g.id) ? byId.get(order[k++]!)!.blocks : g.blocks))
  return next.map((b) =>
    stamp.has(b.id) ? { ...b, settings: { ...b.settings, column: COLUMN_LEFT } } : b,
  )
}

// normalizeColumns снимает биты колонки, которые перестали значить то, что значили
// (спека §11.5) — и у блоков, и у вариантов. Снимаются два вида:
//
//  1. ИНЕРТНЫЙ — раскладчик бит не применил: секции нет (одинокий 'left', 'right' без
//     кого забрать), вторая колонка пуста, пара внутри вопроса не та. Такой флаг
//     легален в контракте (кросс-блочное условие намеренно не валидируется — иначе
//     undo и промежуточные состояния драга ловили бы 422), но в сторе его чистят,
//     чтобы он не воскрес: иначе вставка вопроса выше молча затянула бы блок в чужую
//     секцию.
//  2. СЕКЦИЯ СМЕНИЛАСЬ — от прежней компании не осталось НИКОГО. Бит держится за
//     компанию: «я в этой колонке ЭТОЙ секции», а не «в колонке чего угодно, что
//     окажется рядом». Без этого правила любой вертикальный перенос (Alt+Shift+↑↓,
//     дроп группы, перестановка вариантов) приклеивал бы элемент к посторонней секции.
//     Проверяется только при известном prev (структурная правка); hydrate и undo/redo
//     приезжают со своей раскладкой и подмены не видят — сравнивать им не с чем.
//
//     Компания устойчива именно к тому, к чему обязана: перестановка внутри секции её
//     не меняет (те же лица), приход нового участника не меняет её для остальных, а
//     полноширинный блок, вставленный в середину, разрывает секцию так, что у нижней
//     части от прежней компании не остаётся никого — бит снимается, как и раньше.
//     Исключение одно: placed — элемент, которому бит поставили ИМЕННО СЕЙЧАС
//     (placeInRow), меняет секцию по прямой просьбе, иначе перенос из одной секции в
//     другую был бы no-op'ом.
//
// Оба вида спрашиваются у ТОГО ЖЕ раскладчика, что рисует секции (sectionMates поверх
// packRows/packGroupRows, отдельно packOptionRows): своё правило здесь разъехалось бы
// с рендером — это и был дефект «помечен half — нарисован full».
//
// После уборки документ приводится к КАНОНУ (normalizeSections): левая колонка помечена
// явно, порядок внутри секции колоночный.
// Возвращает исходный массив, если править нечего (дешёвые no-op коммиты).
function normalizeColumns(input: Block[], prev?: Block[], placed?: string): Block[] {
  const blocks = reanchorRowBits(input, prev)
  const clear = new Set<string>() // id блоков, с которых снимаем бит
  const now = sectionMates(blocks)
  for (const b of blocks) {
    if (b.settings?.column !== undefined && !now.has(b.id)) clear.add(b.id) // (1) инертный
  }
  if (prev) {
    const was = sectionMates(prev)
    for (const b of blocks) {
      if (b.settings?.column === undefined || b.id === placed) continue
      const before = was.get(b.id)
      const after = now.get(b.id)
      if (before === undefined || after === undefined) continue
      // (2) от прежней компании не осталось никого.
      if (![...before].some((id) => after.has(id))) clear.add(b.id)
    }
  }
  // Варианты — тот же приём внутри каждого choice-блока.
  const optClear = new Map<string, Set<string>>()
  const prevOptions = new Map(prev?.map((b) => [b.id, b.settings?.options ?? []]))
  for (const b of blocks) {
    const options = b.settings?.options
    if (!options?.length) continue
    const ids = new Set<string>()
    // Инертный бит варианта — тот, который раскладчик не применил: у элемента левой
    // колонки (ряд им ОТКРЫТ, слева никого) он ни к чему не относится.
    for (const row of packOptionRows(options)) {
      const opener = row[0]![0]!
      if (opener.column === COLUMN_RIGHT) ids.add(opener.id)
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
  if (clear.size === 0 && optClear.size === 0) return normalizeSections(blocks)
  const cleaned = blocks.map((b) => {
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
  return normalizeSections(cleaned)
}

// У ВАРИАНТОВ жест по-прежнему предлагает только пустую правую ячейку: раскладчик
// стопку вариантов собрать умеет (ядро общее), но зона дропа у списка своя — ячейка
// целиком, а не полоса у края, — и второго приглашения «под этот вариант» у неё нет.
// Инертным бит от этого не станет: команда просто не выдаётся.
function optionRowHasFreeCell(options: Option[], optionId: string): boolean {
  const row = packOptionRows(options).find((r) =>
    r.some((cell) => cell.some((o) => o.id === optionId)),
  )
  return row?.length === 1
}

// На втором уровне (§6.4) стопки не бывает по построению: пара внутри вопроса — это
// «подпись + поле ответа», а отвечаемый блок в группе не больше одного. Поэтому
// вопрос прежний: свободна ли ячейка ряда, в котором стоит БЛОК id.
function innerRowHasFreeCell(blocks: Block[], id: string): boolean {
  const group = groupBlocks(blocks).find((g) => g.blocks.some((b) => b.id === id))
  const row =
    group &&
    packGroupRows(group.blocks).find((r) => r.some((cell) => cell.some((b) => b.id === id)))
  return row?.length === 1
}

// rowBitOwner — какой бит двигает строка id: свой (внутригрупповой, если строка не
// первая в группе) или группы (кросс-групповой, он на первом блоке). Одно правило на
// клавиатуру, жест и уборку — уровень задаёт МЕСТО блока в группе (§6.3).
function rowBitOwner(blocks: Block[], id: string): Block | null {
  const group = groupBlocks(blocks).find((g) => g.blocks.some((b) => b.id === id))
  if (!group) return null
  const self = group.blocks.find((b) => b.id === id)!
  return self.id !== group.blocks[0]!.id && self.settings?.column === COLUMN_RIGHT
    ? self
    : group.blocks[0]!
}

// groupAnswerable — отвечаемый блок группы gid (носитель бита ряда) или null.
function groupAnswerable(blocks: Block[], gid: string): Block | null {
  return blocks.find((b) => b.groupId === gid && isAnswerableType(b.type)) ?? null
}

// groupIsComplete — в группе есть и подпись, и поле ответа: вопрос собран. В такую
// группу нельзя добавить ни второй ответ, ни второй заголовок (решение владельца
// 2026-07-26) — только лэйаут (text/image), он и есть тело вопроса. Правило
// одинаково у ВСТАВОК: слеш-меню и «+» кладут такое ниже группы, а regroup второй
// подписи в группу не пускает вовсе. Дроп мышью этому правилу с фазы 15 не подчинён
// (§4.1 спеки): перенос — жест автора, который видит, что делает, а не умолчание
// вставки, которое он не выбирал.
function groupIsComplete(blocks: Block[], gid: string): boolean {
  let caption = false
  let answer = false
  for (const b of blocks) {
    if (b.groupId !== gid) continue
    if (isCaptionType(b.type)) caption = true
    else if (isAnswerableType(b.type)) answer = true
  }
  return caption && answer
}

// captionAwaitingField — подпись, у которой ещё нет своего ответа («ждёт поле»).
// Поле, вставленное сразу под такой подписью, входит в ЕЁ группу (regroup склеит) —
// поэтому свой заголовок ему не нужен, даже если тип без заголовка не живёт. Это и
// есть смысл раздела «Отдельные поля»: подсадить ответ к одинокому заголовку,
// который остался, например, после удаления всех вариантов у choice.
function captionAwaitingField(blocks: Block[], block: Block | undefined): boolean {
  return !!block && isCaptionType(block.type) && groupAnswerable(blocks, block.groupId) === null
}

// swapGroupWithNeighbor — перестановка группы блока id с соседней. Один код на два
// жеста: Alt+Shift+↑↓ на любой строке (moveGroup) и Alt+↑↓ на ПОДПИСИ вопроса
// (moveBlock — подпись есть ручка вопроса, а не отдельная строка). null — блок не
// найден или группа уже на границе полотна (no-op, историю и dirty не трогаем).
function swapGroupWithNeighbor(blocks: Block[], id: string, dir: 'up' | 'down'): Block[] | null {
  const cur = blocks.find((b) => b.id === id)
  if (!cur) return null
  // Группы смежны (regroup), поэтому достаточно разложить полотно общим groupBlocks
  // и поменять текущую группу с соседней — внутренний порядок блоков цел.
  const groups = groupBlocks(blocks)
  const gi = groups.findIndex((g) => g.id === cur.groupId)
  const gj = dir === 'up' ? gi - 1 : gi + 1
  // Группа заголовка (если она есть) — нулевая, и она граница, а не сосед по обмену.
  if (gj < (blocks[0]?.type === 'form_title' ? 1 : 0) || gj >= groups.length) return null
  const tmp = groups[gi]!
  groups[gi] = groups[gj]!
  groups[gj] = tmp
  return groups.flatMap((g) => g.blocks)
}

// pinFormTitle — заголовок формы всегда остаётся ПЕРВЫМ блоком (фаза 15, инвариант
// схемы). Нормализация, а не проверка в каждой команде: правило записано один раз для
// ВСЕХ структурных путей — ровно по той же причине, что и уборка бита ряда
// (normalizeColumns). Путь, который о нём забудет, — это документ, отвергнутый
// валидатором на автосейве, то есть «ошибка сохранения» без причины у автора.
//
// Полотно прячет заголовок из списка групп (SlashEditor рисует его отдельной строкой),
// поэтому команды переноса его не видят и без этой страховки выталкивают первый вопрос
// выше него: `Alt+Shift+↑` на первом вопросе и `Alt+↑` на первом блоке давали ровно
// это. Возвращает тот же массив, если двигать нечего (дешёвые no-op коммиты).
function pinFormTitle(blocks: Block[]): Block[] {
  const i = blocks.findIndex((b) => b.type === 'form_title')
  if (i <= 0) return blocks
  const next = blocks.slice()
  const [title] = next.splice(i, 1)
  next.unshift(title!)
  return next
}

// canvasFloor — индекс первой строки, которой автор распоряжается. Приколотый
// заголовок занимает нулевую, и для команд переноса он — граница полотна, а не сосед:
// «двинуть вверх» на первой строке обязано быть no-op'ом (без шага истории и dirty),
// как и на последней. Иначе жест выглядел бы сработавшим, а pinFormTitle молча
// возвращал бы всё назад — правка, которой не было, но с dirty и лишним PATCH.
const canvasFloor = (blocks: Block[]): number => (blocks[0]?.type === 'form_title' ? 1 : 0)

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

// sectionSpanEnd — индекс ПОСЛЕДНЕГО блока секции, в которой стоит блок i; если он не
// в секции — конец его группы. Секция смежна (автомат раскладчика идёт по потоку),
// поэтому участок односвязный, как и у группы.
//
// Нужен всем путям вставки «ниже» (§11.6): полноширинный новичок, уронённый ВНУТРЬ
// секции, её разрезает — у него нет бита, а элемент без бита секцию закрывает. Enter из
// левой колонки создавал бы строку между колонками, и структура рассыпалась бы на
// глазах (отчёт владельца 2026-07-29). Правильное место — ПОСЛЕ всей секции.
function sectionSpanEnd(blocks: Block[], i: number): number {
  const groups = rowGroups(blocks)
  const gid = blocks[i]!.groupId
  const row = packRows(groups).find((r) => r.some((cell) => cell.some((g) => g.id === gid)))
  if (!row || row.length < 2) return groupSpan(blocks, i)[1]
  const last = row.flat().at(-1)!.blocks.at(-1)!.id
  return blocks.findIndex((b) => b.id === last)
}

// groupEndAfter — индекс вставки ПОСЛЕ всей группы afterId, а если она стоит в секции —
// после всей СЕКЦИИ (в конец при null или ненайденном). Отвечаемое поле/бандл
// вставляется сюда: инпут не встраивается между подписью и контролом группы, а
// начинает новую группу ниже (фаза 8.7).
function groupEndAfter(blocks: Block[], afterId: string | null): number {
  if (!afterId) return blocks.length
  const i = blocks.findIndex((b) => b.id === afterId)
  if (i < 0) return blocks.length
  return sectionSpanEnd(blocks, i) + 1
}

// planBlockDrop — чистый расчёт блочного дропа: activeId переносится на позицию
// overId (плоский сплайс, как arrayMove у sortable). Строка роняется в ЛЮБУЮ
// позицию полотна, включая середину чужого вопроса: замок «отвечаемый блок и
// подпись приземляются ПОД чужой мульти-группой» снят фазой 15 (§4.1 спеки).
// Он охранял единственный реальный ущерб — кражу подписи (regroup отдаёт заголовок
// пришельцу, прежнее поле остаётся голым, и колонка CSV молча переименовывается);
// решение владельца — не запрещать, а делать громким: жертву видно во время драга
// и её называет тост с отменой после (captionLoss, §4.3).
//
// Раскладка `blocks` — СЫРАЯ (groupId старые): это прогноз, а не результат, и
// раскладывает её regroup у того, кто спрашивает (captionLoss зовёт его сам).
//
// groupIds — состав ВОПРОСА, в который активный блок войдёт после дропа, в порядке
// документа и вместе с самим активным. По нему полотно зажигает рейл будущей группы
// (§5 EDITOR.md): единственный ответ на вопрос «этот блок сейчас станет частью
// вопроса — какого?». Пусто — блок останется одиночкой, зажигать нечего.
export function planBlockDrop(
  blocks: Block[],
  activeId: string,
  overId: string,
): { blocks: Block[]; groupIds: string[] } | null {
  const from = blocks.findIndex((b) => b.id === activeId)
  const to = blocks.findIndex((b) => b.id === overId)
  if (from < 0 || to < 0 || from === to) return null
  const active = blocks[from]!
  const next = blocks.slice()
  next.splice(from, 1)
  next.splice(to, 0, active) // вставка на индекс overId в списке БЕЗ активного = arrayMove
  const predicted = regroup(next)
  const gid = predicted.find((b) => b.id === activeId)!.groupId
  const members = predicted.filter((b) => b.groupId === gid)
  return { blocks: next, groupIds: members.length > 1 ? members.map((b) => b.id) : [] }
}

// RowPosition — где вопрос стоит на ОСИ КОЛОНОК (§11.6). Не «состояние блока» (в
// документе хранится один бит), а вывод из раскладки: что именно сделают Mod+Alt+←/→ на
// этой строке. Пять значений, потому что пять разных исходов, и подсказка обязана
// называть свой:
//
//   solo       — полная ширина, встать в ряд не с кем (первый вопрос полотна либо
//                предыдущий занимает всю ширину сам, §6.5) → молчат оба шага;
//   enter      — полная ширина, есть подходящий предыдущий → шаг ставит в ряд с ним, и
//                клавиша выбирает колонку (вправо в правую, влево в левую);
//   left       — левая колонка секции → вправо в правую колонку, влево из секции;
//   rightSolo  — правая колонка, элемент в ней один → влево = выйти из секции (переезд
//                оставил бы колонку пустой, а такой секции не бывает);
//   rightStack — правая колонка со стопкой → влево = переехать в левую колонку.
//
// Спрашивается у ПЕРВОЙ строки группы: у остальных ось своя, короче (ряд внутри вопроса
// — направленная пара «подпись | поле», §6.6), и решает её rowBitOwner.
export type RowPosition = 'solo' | 'enter' | 'left' | 'rightSolo' | 'rightStack'

export function rowPosition(blocks: Block[], id: string): RowPosition {
  const groups = rowGroups(blocks)
  const gi = groups.findIndex((g) => g.blocks.some((b) => b.id === id))
  if (gi < 0) return 'solo'
  const group = groups[gi]!
  const row = packRows(groups).find((r) => r.some((c) => c.some((g) => g.id === group.id)))
  if (row && row.length > 1) {
    if (row[0]!.some((g) => g.id === group.id)) return 'left'
    return row[1]!.length > 1 ? 'rightStack' : 'rightSolo'
  }
  const prev = groups[gi - 1]
  const canEnter =
    prev !== undefined && groupCanShareRow(prev.blocks) && groupCanShareRow(group.blocks)
  return canEnter ? 'enter' : 'solo'
}

// needsCaptionFor — строке ответа не хватает заголовка (§4.4 спеки фазы 15): она
// отвечаемая, своего текста не несёт (у consent текст и есть строка вопроса), и
// подписи в её группе нет. Один предикат на два места, которые обязаны совпадать:
// полотно решает им, показывать ли чип «дать заголовок», а шпаргалка — обещать ли
// Mod+Alt+T. Разъедься они — карта соврала бы, а это баг (демо-критерий 13.5).
export function needsCaptionFor(blocks: Block[], id: string): boolean {
  const b = blocks.find((x) => x.id === id)
  if (!b || !isAnswerableType(b.type) || carriesText(b.type)) return false
  return !blocks.some((x) => x.groupId === b.groupId && isCaptionType(x.type))
}

// captionLoss — какие вопросы теряют заголовок от правки (§4.3 спеки фазы 15).
// Цена свободы строки ответа: увели поле из вопроса, уронили чужое между подписью
// и полем, удалили подпись — и заголовок, по которому вопрос звался в CSV и в
// воронке, у поля пропал. ОТВЕТЫ при этом целы всегда (они ключуются id
// отвечаемого блока), ломается отчёт — поэтому правило не запрещает операцию, а
// делает её громкой: подсветка жертвы во время драга и тост с отменой после.
//
// Считается по двум раскладкам и только по ним: чистая функция, о тостах и
// подсветке не знает — показывать ли их, решает полотно. Учитываются лишь
// отвечаемые блоки, ЖИВЫЕ в обоих списках: удалённому терять нечего, ответы на
// него всё равно осиротели.
//
// regroup зовётся на оба списка: во время драга сюда приходит СЫРОЙ прогноз
// planBlockDrop (groupId там ещё старые), а после операции — уже разложенный
// документ, для которого regroup идемпотентен и возвращает тот же массив.
// Заголовок группы считает groupMeta — тот же код, что рисует подпись превью,
// рендереру и сводке ответов (title перебивает label, пустой текст не в счёт).
export function captionLoss(before: Block[], after: Block[]): { id: string; caption: string }[] {
  const was = regroup(before)
  const now = regroup(after)
  const wasMeta = groupMeta(was)
  const nowMeta = groupMeta(now)
  const nowById = new Map(now.map((b) => [b.id, b]))
  const lost: { id: string; caption: string }[] = []
  for (const b of was) {
    if (!isAnswerableType(b.type)) continue
    const caption = wasMeta.get(b.groupId)?.caption ?? ''
    if (caption === '') continue // терять было нечего
    const survivor = nowById.get(b.id)
    if (!survivor) continue
    if ((nowMeta.get(survivor.groupId)?.caption ?? '') === '') lost.push({ id: b.id, caption })
  }
  return lost
}

// rowBoundaryTarget — РЯД АТОМАРЕН ДЛЯ ВЕРТИКАЛЬНОЙ ВСТАВКИ (спека §5). Полотно во
// время драга остаётся двумерным (в столбик не сворачивается), и ровно в одной позиции
// verticalListSortingStrategy врёт: цель «щель между участниками ряда». Уронённый туда
// блок либо сам занимает левую ячейку правого участника, либо гасит его бит — в обоих
// случаях ряд рвётся, а щель показывала не это. Лечится подменой цели границей ряда:
// сверху — последняя строка ряда (блок ложится под ряд), снизу — строка за рядом.
//
// С фазы 15 это ЕДИНСТВЕННАЯ подмена цели на полотне: правило «отвечаемый блок и
// подпись не приземляются внутрь чужой мульти-группы» снято вместе со своим слоем
// отклика (remapDropTarget), и композиции двух подмен больше нет.
//
// Вставки ВНУТРЬ участника ряда это не касается: контент, добавленный в вопрос, ряд не
// рвёт (участник остаётся тем же участником) — и остаётся легальным, как был.
export function rowBoundaryTarget(
  blocks: Block[],
  activeId: string,
  overId: string,
): string | null {
  const ai = blocks.findIndex((b) => b.id === activeId)
  const ti = blocks.findIndex((b) => b.id === overId)
  if (ai < 0 || ti < 0 || ai === ti) return null
  const at = (id: string) => blocks.findIndex((b) => b.id === id)
  // Пролёты рядов ОБОИХ уровней (§6.6): ряд из двух вопросов и ряд «подпись | поле»
  // внутри вопроса — одна и та же ложь verticalListSortingStrategy и одно лечение.
  // Пересечься они не могут: группа с внутренним рядом в кросс-групповой не встаёт
  // (§6.5), поэтому порядок проверки пролётов ни на что не влияет.
  //
  //   rs — первая строка ряда, re — последняя, mids — первые строки КАЖДОГО участника
  // после первого. Границ в ряду столько же, сколько участников минус один: правая
  // колонка это стопка (§5), и щель между её элементами — та же ложь, что щель между
  // колонками. Прочие цели внутри ряда легальны: вставка ВНУТРЬ участника (контент в
  // вопрос) ряд не рвёт — участник остаётся тем же участником.
  const groups = rowGroups(blocks)
  const spans: { rs: number; re: number; mids: number[] }[] = []
  for (const row of packRows(groups)) {
    const participants = row.flat()
    if (participants.length < 2) continue
    const lastGroup = participants[participants.length - 1]!.blocks
    spans.push({
      rs: at(participants[0]!.blocks[0]!.id),
      re: at(lastGroup[lastGroup.length - 1]!.id),
      mids: participants.slice(1).map((g) => at(g.blocks[0]!.id)),
    })
  }
  for (const g of groups) {
    for (const row of packGroupRows(g.blocks)) {
      const participants = row.flat()
      if (participants.length < 2) continue
      spans.push({
        rs: at(participants[0]!.id),
        re: at(participants[participants.length - 1]!.id),
        mids: participants.slice(1).map((b) => at(b.id)),
      })
    }
  }
  for (const { rs, re, mids } of spans) {
    // Сначала «цель не в этом ряду» и только потом «активный из этого ряда»: обратный
    // порядок выходил из ЦИКЛА на первом же ряду, где нашёлся активный, и защита не
    // доставалась ни одному ряду ниже — участник верхнего ряда мог уронить блок в
    // щель нижнего.
    if (ti < rs || ti > re) continue
    if (ai >= rs && ai <= re) return null // цель в СВОЁМ ряду — перестановка свободна
    // Позиция вставки = индекс цели в исходном списке (арифметика planBlockDrop).
    // Сверху щель даёт цель «последняя строка участника ДО границы» → подменяем концом
    // ряда (блок ложится под ряд); снизу — «первая строка участника ПОСЛЕ границы» →
    // строкой за рядом.
    for (const mid of mids) {
      if (ai < rs) {
        if (ti === mid - 1) return blocks[re]!.id
      } else if (ti === mid) return blocks[re + 1]?.id ?? null
    }
    return null
  }
  return null
}

// rowBoundaryGroup — то же правило «ряд атомарен для вертикальной вставки» (§5), но на
// ГРУППОВОМ слое, где его не было вовсе (найдено владельцем 2026-08-02: «таскаю группу
// и не могу поставить её между обычным блоком и рядом — они склеиваются, как будто это
// группа»).
//
// Причина ровно та же, что у блочного правила, но последствие грубее. `reorderGroups` —
// голый arrayMove по группам, и цель «правая колонка ряда» при переносе сверху вниз
// кладёт группу МЕЖДУ колонками. Дальше раскладчик читает получившийся список буквально
// (§13): пришелец без бита закрывает секцию, левый участник выпадает во всю ширину, а
// правый со своим `'right'` открывает НОВУЮ секцию и забирает в неё пришельца. Автор
// целился в щель над рядом, а получил ряд с новым составом — «склеились».
//
// Лечение — то, что §5 уже обещает: **ряд для вертикальной вставки одна цель**. Тащат
// сверху — кладём ПОД ряд (цель = последний участник), снизу — НАД ним (цель = первый).
// Так ряд ведёт себя как один высокий блок, чем он для этого жеста и является.
// Перестановка ВНУТРИ своего ряда правилу не подчиняется: там щель между колонками —
// законная цель, ею меняют участников местами.
export function rowBoundaryGroup(
  blocks: Block[],
  activeGroupId: string,
  overGroupId: string,
): string | null {
  const groups = rowGroups(blocks)
  const at = (id: string) => groups.findIndex((g) => g.id === id)
  const ai = at(activeGroupId)
  const ti = at(overGroupId)
  if (ai < 0 || ti < 0 || ai === ti) return null
  for (const row of packRows(groups)) {
    // Участники ряда смежны в списке групп (ряды собираются из идущих подряд), поэтому
    // границы пролёта — индексы первого и последнего.
    const participants = row.flat()
    if (participants.length < 2) continue
    const rs = at(participants[0]!.id)
    const re = at(participants[participants.length - 1]!.id)
    if (ti < rs || ti > re) continue
    if (ai >= rs && ai <= re) return null
    return ai < rs ? groups[re]!.id : groups[rs]!.id
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
      blocks.map((b) =>
        b.id === blockId ? { ...b, settings: { ...b.settings, options: next } } : b,
      ),
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
  cover: s.cover,
  logo: s.logo,
})

// updateBlockTag коалесит непрерывный ввод через updateBlock: правки текстовых полей
// (text/settings-placeholder/name) в один блок делят шаг истории; патч с required (или
// иным дискретным полем) — свой шаг (тег null).
//
// Имя вопроса (этап 16.4) — третье такое поле и первый потребитель склейки ВНЕ
// settings: без него имя из двадцати символов стоило бы двадцати нажатий Mod+Z (§4.6
// спеки). Тег строится из ключей патча, поэтому набор имени и набор подписи в один и
// тот же блок в общий шаг НЕ сливаются — это разные поля, и общий шаг откатывал бы
// вместе с именем всю набранную подпись.
//
// Форматирование (`kind: 'format'`) коалесится ОТДЕЛЬНО от набора, хотя патч у них
// один и тот же — `{ text }`. Общий тег означал бы, что «набрал подпись, выделил слово,
// покрасил» — это один шаг, и первый же Ctrl+Z сносил бы вместе с цветом всю набранную
// подпись. Внутри самого жеста коалесценция нужна и остаётся: выборщик цвета шлёт
// правку на каждом кадре перетаскивания, и 60 шагов истории в секунду — не история.
function updateBlockTag(id: string, patch: BlockPatch, kind?: UpdateKind): string | null {
  if (kind === 'format') return `ub:${id}:format`
  const keys = Object.keys(patch)
  const textOnly =
    keys.length > 0 && keys.every((k) => k === 'text' || k === 'settings' || k === 'name')
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
      // Порядок обязателен: сперва заголовок встаёт на своё место (pinFormTitle), и
      // только потом считаются группы — перенос меняет соседство, а regroup выводит
      // groupId именно из него.
      return {
        ...patch,
        blocks: normalizeColumns(regroup(pinFormTitle(patch.blocks)), get().blocks, placed),
      }
    }

    return {
      blocks: [],
      submitLabel: '',
      thankYouText: '',
      redirectUrl: '',
      cover: undefined,
      logo: undefined,
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
          cover: schema.cover,
          logo: schema.logo,
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
          // Подпись в СОБРАННЫЙ вопрос не встраивается — ложится под ним, как поле и
          // как вопрос (§3): второго заголовка у вопроса не бывает, и regroup всё
          // равно отдал бы группу ближайшей к полю подписи, молча переименовав вопрос
          // в CSV и воронке. Лэйаут (text/image) внутрь группы по-прежнему ложится.
          const at =
            i < 0
              ? s.blocks.length
              : isCaptionType(type) && groupIsComplete(s.blocks, s.blocks[i]!.groupId)
                ? sectionSpanEnd(s.blocks, i) + 1
                : i + 1
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
            text: carriesText(type) ? src.text : [],
            // Имя переживает смену типа (§5.4 спеки): его дал автор, и относится оно к
            // вопросу, а не к тому, чем на него отвечают. Роняется ровно там, где ему
            // нечего называть — новый тип не собирает ответов (и схема имя у такого
            // запрещает).
            name: isAnswerableType(type) ? src.name : undefined,
            required: isAnswerableType(type) ? src.required : false,
          }
          // Ширина и колонки вариантов переезжают, пока новый тип их несёт (смена
          // short_text→email не должна молча разваливать ряд); вне whitelist они
          // роняются здесь — иначе автосейв ловил бы 422 (нормализация добьёт пару).
          carryLayout(src, converted)
          carryPlaceholder(src, converted)
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
          const field: Block = { ...newBlock(type), text: [] }
          if (gStart === gEnd) {
            // Одиночный блок (своя группа) → он становится подписью, поле под ним.
            // Фокус на подпись (у неё textarea, автор правит текст вопроса дальше).
            // Подпись, уже бывшая подписью, свой размер сохраняет: label не обязан
            // вырасти в title только потому, что ему подсадили поле.
            const title: Block = {
              ...src,
              type: isCaptionType(src.type) ? src.type : 'title',
              // Бит ряда ОСТАЁТСЯ на подписи: она встаёт на место src и остаётся
              // головой группы, то есть носителем кросс-группового бита (v4, §6.3).
              // «Дать вопросу подпись» не должно разваливать ряд. Умеет ли новая
              // группа делить ряд, решит раскладчик: не умеет — normalizeColumns
              // снимет бит как инертный. Остальные settings подписи не нужны.
              settings: src.settings?.column === COLUMN_RIGHT ? { column: COLUMN_RIGHT } : {},
              required: false,
            }
            focus = title.id
            const blocks = s.blocks.slice()
            blocks.splice(i, 1, title, field)
            return structural({ blocks })
          }
          // Блок ВНУТРИ группы → новый вопрос НИЖЕ группы: инпут не встраивается между
          // подписью и контролом, а начинает новую группу. Текущий блок — контент.
          // Ниже СЕКЦИИ, а не только группы: полноширинный вопрос, вставленный между
          // колонками, разрезал бы секцию (§11.6).
          const title = newBlock('title')
          focus = title.id
          const blocks = s.blocks.slice()
          blocks.splice(sectionSpanEnd(s.blocks, i) + 1, 0, title, field)
          return structural({ blocks })
        })
        return focus
      },

      makeField: (id, type) => {
        const src0 = get().blocks.find((b) => b.id === id)
        // Тип, которому обязателен заголовок, голым не вставляется (requiresCaption).
        // Единственное место, где он всё-таки встаёт один, — подпись, ждущая поле:
        // там он входит в ЕЁ группу, и заголовок у него есть. Во всех остальных
        // местах жест вырождается в «Вопросы» — поле приезжает со своим заголовком.
        if (src0 && requiresCaption(type) && !captionAwaitingField(get().blocks, src0)) {
          return get().makeQuestion(id, type)
        }
        let focus = id
        commit(null, (s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          const src = s.blocks[i]
          if (!src) return null
          const [gStart, gEnd] = groupSpan(s.blocks, i)
          if (gStart === gEnd && !isCaptionType(src.type)) {
            // Одиночный блок → конверсия на месте в голое поле (текст роняется — у
            // поля его нет). Тот же путь, что changeBlockType на отвечаемый тип;
            // ширина/колонки переезжают по тому же правилу (carryLayout).
            const field: Block = { ...newBlock(type), id }
            carryLayout(src, field)
            return structural({
              blocks: s.blocks.map((b) => (b.id === id ? field : b)),
            })
          }
          // Внутри группы → голое поле новой группой ниже; текущий блок остаётся.
          // На ОДИНОКОЙ ПОДПИСИ — то же место (сразу под ней), но смысл другой: поле
          // входит в её группу, и это жест «подсадить ответ к заголовку». Конверсией
          // на месте здесь идти нельзя — она уронила бы текст заголовка.
          const field = newBlock(type)
          focus = field.id
          const blocks = s.blocks.slice()
          // У ОДИНОКОЙ ПОДПИСИ поле встаёт вплотную под ней — оно входит в ЕЁ группу
          // (regroup склеит), и секцию это не рвёт: голова группы бит сохраняет. Во
          // всех остальных случаях поле начинает новую группу, а значит должно уйти
          // ниже всей секции (§11.6).
          const at = gStart === gEnd ? gEnd + 1 : sectionSpanEnd(s.blocks, i) + 1
          blocks.splice(at, 0, field)
          return structural({ blocks })
        })
        return focus
      },

      addQuestionAfter: (afterId, type) => {
        const title = newBlock('title')
        const field = newBlock(type)
        commit(null, (s) => {
          const at = groupEndAfter(s.blocks, afterId)
          const blocks = s.blocks.slice()
          blocks.splice(at, 0, title, field)
          return structural({ blocks })
        })
        return title.id
      },

      addFieldAfter: (afterId, type) => {
        const field = newBlock(type)
        let focus = field.id
        commit(null, (s) => {
          const at = groupEndAfter(s.blocks, afterId)
          const blocks = s.blocks.slice()
          // То же правило, что у makeField, но точку вставки диалог «+» выбирает сам
          // (после всей группы afterId), поэтому спрашиваем блок НАД ней: подпись,
          // ждущая поле, принимает его в свою группу; иначе поле приезжает с
          // заголовком, и каретка встаёт на заголовок (§12, как у addQuestionAfter).
          if (requiresCaption(type) && !captionAwaitingField(s.blocks, s.blocks[at - 1])) {
            const title = newBlock('title')
            focus = title.id
            blocks.splice(at, 0, title, field)
          } else {
            blocks.splice(at, 0, field)
          }
          return structural({ blocks })
        })
        return focus
      },

      addCaptionFor: (id) => {
        // Пригодность решаем ДО commit: жест приходит с чипа и с клавиши, и на
        // строке, которой заголовок не нужен, он обязан быть no-op'ом без шага
        // истории и без dirty — иначе Ctrl+Z съел бы нажатие, которое ничего не
        // сделало (тот же закон, что у границы moveBlock).
        const s0 = get()
        const src = s0.blocks.find((b) => b.id === id)
        if (!src || !isAnswerableType(src.type) || carriesText(src.type)) return null
        // Второго заголовка у вопроса не бывает (решение владельца 2026-07-26):
        // подпись в группе уже есть — добавлять нечего.
        if (s0.blocks.some((b) => b.groupId === src.groupId && isCaptionType(b.type))) return null
        const title = newBlock('title')
        commit(null, (s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          if (i < 0) return null
          const blocks = s.blocks.slice()
          // Строго НАД полем: regroup ищет подпись от поля вверх через контент, и
          // вставленная вплотную она склеивается с ним в вопрос. Голое поле — группа
          // из одного блока, поэтому чужой вопрос этим не задет.
          blocks.splice(i, 0, title)
          return structural({ blocks })
        })
        return title.id
      },

      updateBlock: (id, patch, kind) =>
        commit(updateBlockTag(id, patch, kind), (s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          const src = s.blocks[i]
          // Блока нет — правку не к чему применить, и это не редкость: сюда
          // приходит отложенный колбэк, переживший свой блок (загрузка картинки
          // завершилась после того, как автора удалил блок). Прежде такой вызов
          // всё равно проходил через commit — `blocks.map` возвращает новый массив
          // даже когда ни один блок не совпал, — и давал шаг истории, в котором
          // ничего не меняется (Ctrl+Z «съедал» нажатие), dirty и лишний PATCH.
          if (!src) return null
          // Патч ничего не меняет — тот же no-op. Сравнение по ссылке годится для
          // required (примитив) и settings (приходит новым объектом только когда его
          // действительно пересобрали), но НЕ для text: с фазы 14 это массив спанов,
          // и каждый набранный символ приносит свежий массив с тем же содержимым.
          // По ссылке такой патч выглядел бы изменением — и «правка, которая ничего
          // не меняет» перестала бы быть no-op: лишний шаг истории (Ctrl+Z съедает
          // нажатие), dirty и лишний PATCH на каждый отложенный колбэк.
          const keys = Object.keys(patch) as (keyof BlockPatch)[]
          const same = (k: keyof BlockPatch) =>
            k === 'text' ? sameRichText(src.text, patch.text) : Object.is(src[k], patch[k])
          if (keys.every(same)) return null
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
          const a = s.blocks[i]
          if (!a) return null
          // Подпись вопроса — ручка вопроса, а не отдельная строка: Alt+↑↓ на ней
          // двигает ВСЮ группу. Иначе подпись уезжает из своего вопроса и ниже молча
          // усыновляет чужое голое поле — та же кража подписи, от которой защищён
          // дроп (§5), только клавиатурой. Подпись без ответа (одинокая) двигается
          // как обычный блок: её группа — она сама.
          if (isCaptionType(a.type) && groupAnswerable(s.blocks, a.groupId)) {
            const blocks = swapGroupWithNeighbor(s.blocks, id, dir)
            return blocks ? structural({ blocks }) : null
          }
          const j = dir === 'up' ? i - 1 : i + 1
          const b = s.blocks[j]
          // Граница полотна снизу — конец списка, сверху — приколотый заголовок
          // (canvasFloor): он сосед по списку, но не сосед по обмену.
          if (!b || j < canvasFloor(s.blocks)) return null // на границе — ничего не меняем
          const blocks = s.blocks.slice()
          blocks[i] = b
          blocks[j] = a
          return structural({ blocks })
        }),

      moveGroup: (id, dir) =>
        commit(null, (s) => {
          // То же, что reorderGroups, но на один шаг вверх/вниз (Alt+Shift+стрелки),
          // а не в позицию дропа.
          const blocks = swapGroupWithNeighbor(s.blocks, id, dir)
          return blocks ? structural({ blocks }) : null
        }),

      reorderBlocks: (activeId, overId) =>
        commit(null, (s) => {
          // Плоский перенос одной строки через planBlockDrop: arrayMove — как
          // sortable и показывает. Куда именно строка приземлится, метод не
          // ограничивает (замок снят, §4.1 спеки фазы 15): принадлежность группам
          // после переноса выводит regroup, а потерю заголовка называет полотно
          // (captionLoss). Целостность мульти-группы при переносе ЕЁ САМОЙ охраняет
          // не этот метод, а UI: подпись мульти-группы несёт групповую ручку →
          // reorderGroups.
          const plan = planBlockDrop(s.blocks, activeId, overId)
          return plan ? structural({ blocks: plan.blocks }) : null
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

      duplicateBlock: (id) => {
        // Возвращаем id первой строки КОПИИ — иначе после «Дублировать» из попапа
        // каретке некуда встать: поповер закрылся, возврат фокуса на его якорь мы
        // гасим сами (иначе фокус уходит на позиционированный span), и активным
        // элементом остаётся body. Контракт §12: каждая операция полотна кончается
        // детерминированным фокусом, и «копия появилась, а каретка нигде» — ровно тот
        // класс дефектов, ради которого контракт заведён.
        let focus: string | null = null
        commit(null, (s) => {
          const i = s.blocks.findIndex((b) => b.id === id)
          const src = s.blocks[i]
          if (!src) return null
          // Вопросом целиком дублируются два случая.
          //
          // 1. Поле, которому обязателен заголовок: копия одного такого поля осталась бы
          //    голой — состояния, которого не бывает.
          // 2. ПОДПИСЬ, стоящая во главе собранного вопроса (фаза 16, §4.2 спеки):
          //    подпись — ручка вопроса во всех остальных жестах (мусорка сносит группу,
          //    драг тащит группу, Alt+↑↓ двигает вопрос), и «дублировать» из её попапа
          //    обязано значить то же. Копия одной подписи была бы вторым заголовком
          //    вплотную к своему вопросу — ровно то состояние, которое EDITOR §3
          //    запрещает как молчаливую подмену имени вопроса.
          //
          // Остальные блоки дублируются по одному, как раньше.
          const span = groupSpan(s.blocks, i)
          const headsQuestion = isCaptionType(src.type) && span[0] === i && span[1] > span[0]
          const [from, to] = requiresCaption(src.type) || headsQuestion ? span : [i, i]
          const copies = s.blocks
            .slice(from, to + 1)
            .map((b): Block => ({ ...cloneBlock(b), id: newBlockId() }))
          focus = copies[0]!.id
          const blocks = s.blocks.slice()
          blocks.splice(to + 1, 0, ...copies)
          return structural({ blocks })
        })
        return focus
      },

      placeInRow: (activeGroupId, targetGroupId, side = 'right') =>
        commit(null, (s) => {
          if (activeGroupId === targetGroupId) return null
          const groups = groupBlocks(s.blocks)
          const from = groups.findIndex((g) => g.id === activeGroupId)
          const targetGroup = groups.find((g) => g.id === targetGroupId)
          if (from < 0 || !targetGroup) return null
          // Группа с внутренним рядом занимает всю ширину и в секцию не встаёт (§6.5).
          if (!groupCanShareRow(groups[from]!.blocks)) return null
          if (!groupCanShareRow(targetGroup.blocks)) return null
          // Заголовок формы колонку не делит (ADR §10). Полотно его в списке групп и не
          // показывает, но команда обязана быть честной сама по себе: бит на заголовке —
          // документ, который отвергнет валидатор.
          if (!canShareRow(groups[from]!.blocks[0]!.type)) return null
          if (!canShareRow(targetGroup.blocks[0]!.type)) return null

          // side — КОЛОНКА, В КОТОРУЮ ВСТАЁТ АКТИВНЫЙ, а не «с какой стороны от цели».
          // Так читается жест: зона слева — «в левую колонку», справа — «в правую», и
          // для цели, уже стоящей в секции, это единственная осмысленная трактовка
          // (её сосед по колонке уже есть, вопрос лишь в какую колонку добавить).
          const activeHead = groups[from]!.blocks[0]!
          const bit = side === COLUMN_LEFT ? COLUMN_LEFT : COLUMN_RIGHT
          // Секция цели, если она есть: нужна, чтобы вставить активного В КОНЕЦ нужной
          // колонки. Полагаться на нормализацию канона тут нельзя — она выводится из
          // раскладки, а неверно вставленный 'left' ПОСЛЕ 'right' раскладчик прочтёт
          // как начало новой секции (§11.3), и она уже не склеится.
          // Раскладка — по документу без заголовка формы (rowGroups), а перестановка
          // ниже — по полному списку групп: заголовок остаётся на своём месте.
          const rows = packRows(rowGroups(s.blocks))
          const row = rows.find((r) => r.some((cell) => cell.some((g) => g.id === targetGroupId)))
          const inSection = row !== undefined && row.length > 1
          // Куда вставлять: в конец колонки-получателя, а если секции ещё нет —
          // вплотную к цели (тогда секция и создаётся этой командой).
          const anchor = inSection
            ? (side === COLUMN_LEFT ? row![0]! : row![1]!).at(-1)!.id
            : targetGroupId
          // Цель полноширинная → секция создаётся: она забирает противоположную
          // колонку. Активный слева — цель становится правой, и наоборот.
          const targetBit = inSection ? null : bit === COLUMN_LEFT ? COLUMN_RIGHT : COLUMN_LEFT
          const targetHead = targetGroup.blocks[0]!

          // Уходя, активный обязан ПОГАСИТЬ за собой умирающую секцию: если после его
          // выреза в прежней секции одна из колонок пустеет, её остаток остаётся с
          // битом, который уже ничего не значит. Сам раскладчик этого не увидит — рядом
          // может оказаться новая секция, и остаток молча вольётся в её левую колонку
          // (две соседние секции в явной форме неразличимы, §11.3). Поэтому гасим здесь,
          // по прежней раскладке, где секция ещё видна целиком.
          //
          // ВНУТРИ СВОЕЙ ЖЕ СЕКЦИИ гасить нечего, и гасить нельзя: переезд между колонками
          // (`shiftColumn`) оставляет прежнюю колонку пустой по построению, но остаток
          // никуда не уходит — раскладчик сам вернёт секцию, забрав первого из уцелевшей
          // колонки в левую (§11.3). Погасив его бит, команда вместо переезда разваливала
          // бы секцию: при стопке справа один участник выпадал во всю ширину, а второй
          // молча переезжал в левую колонку (найдено ревью).
          const orphans = new Set<string>()
          const oldRow = rows.find((r) =>
            r.some((cell) => cell.some((g) => g.id === activeGroupId)),
          )
          if (oldRow && oldRow !== row && oldRow.length > 1) {
            const rest = oldRow.map((cell) => cell.filter((g) => g.id !== activeGroupId))
            if (rest.some((cell) => cell.length === 0)) {
              for (const cell of rest) for (const g of cell) orphans.add(g.blocks[0]!.id)
            }
          }

          const [moved0] = groups.splice(from, 1)
          // Позицию якоря ищем ПОСЛЕ выреза активной группы: до него индексы сдвинуты.
          const at = groups.findIndex((g) => g.id === anchor)
          if (at < 0) return null
          // В левую колонку вставляем ПЕРЕД якорем, только когда секция создаётся: там
          // якорь — сама цель, и слева от неё активный и должен оказаться. Внутри уже
          // существующей секции якорь — последний элемент колонки, и встаём за ним.
          const before = !inSection && bit === COLUMN_LEFT
          groups.splice(before ? at : at + 1, 0, moved0!)

          const moved = structural(
            {
              blocks: groups
                .flatMap((g) => g.blocks)
                .map((b) => {
                  if (b.id === activeHead.id)
                    return { ...b, settings: { ...b.settings, column: bit } }
                  if (targetBit !== null && b.id === targetHead.id) {
                    return { ...b, settings: { ...b.settings, column: targetBit } }
                  }
                  return orphans.has(b.id) ? withoutColumn(b) : b
                }),
            },
            // Смена секции здесь — по прямой просьбе, а не побочный эффект переноса.
            activeHead.id,
          )!
          // Бит не приземлился (пара не сложилась) — normalizeColumns его снял, а
          // «перенос вплотную к цели» без секции не то, о чём просили: откатываем весь
          // патч, чтобы не мусорить в истории.
          const landed = moved.blocks.find((b) => b.id === activeHead.id)
          return landed?.settings?.column !== undefined ? moved : null
        }),

      takeOwnRow: (id) =>
        commit(null, (s) => {
          // Какой бит снимать, решает место строки в группе (rowBitOwner): своя строка
          // выходит из ряда ВНУТРИ вопроса, голова — из ряда вопросов.
          const owner = rowBitOwner(s.blocks, id)
          if (!owner || owner.settings?.column === undefined) return null
          const strip = (ids: Set<string>) =>
            structural({ blocks: s.blocks.map((b) => (ids.has(b.id) ? withoutColumn(b) : b)) })
          const groups = rowGroups(s.blocks)
          const gi = groups.findIndex((g) => g.blocks[0]!.id === owner.id)
          // Носитель не голова группы → бит внутригрупповой: поле выходит из ряда со
          // своей подписью, порядок блоков не меняется (§6.6).
          if (gi < 0) return strip(new Set([owner.id]))
          const group = groups[gi]!
          const row = packRows(groups).find((r) => r.some((c) => c.some((g) => g.id === group.id)))
          // Бит есть, а секции нет — он инертен: просто снять (уборка сделала бы это и
          // сама, но тогда команда вернула бы «правку», в которой ничего не менялось).
          if (!row || row.length < 2) return strip(new Set([owner.id]))
          const mine = row.find((c) => c.some((g) => g.id === group.id))!
          if (mine.length === 1) {
            // Колонка пустеет → секции больше нет. Гасим биты ВСЕХ её участников: у
            // остатка бит уже ничего не значит, а раскладчик этого не увидит — ниже
            // может стоять другая секция, и остаток молча вольётся в её колонку (§11.3).
            const ids = new Set(row.flat().map((g) => g.blocks[0]!.id))
            return strip(ids)
          }
          // Секция переживёт уход: полноширинный блок В СЕРЕДИНЕ разрезал бы её пополам,
          // поэтому вопрос уезжает ПОД неё — туда же, куда Enter из колонки кладёт новую
          // строку (sectionSpanEnd).
          const rest = groupBlocks(s.blocks).filter((g) => g.id !== group.id)
          const lastId = row
            .flat()
            .filter((g) => g.id !== group.id)
            .at(-1)!.id
          const at = rest.findIndex((g) => g.id === lastId)
          if (at < 0) return null
          rest.splice(at + 1, 0, group)
          return structural({
            blocks: rest
              .flatMap((g) => g.blocks)
              .map((b) => (b.id === owner.id ? withoutColumn(b) : b)),
          })
        }),

      shiftColumn: (id, dir) => {
        const s = get()
        const pos = rowPosition(s.blocks, id)
        const groups = rowGroups(s.blocks)
        const gi = groups.findIndex((g) => g.blocks.some((b) => b.id === id))
        if (gi < 0) return
        const gid = groups[gi]!.id
        // Полная ширина: ВХОД в ряд с предыдущим, и сторона выбирается клавишей — вправо
        // в правую колонку, влево в левую (§11.6). Цель одна и та же, предыдущая группа:
        // если она стоит в секции, placeInRow сам якорится в конец нужной колонки, а если
        // нет — секция этой командой и создаётся. Ряд из двоих собирается одним нажатием,
        // как и до этапа.
        if (pos === 'enter') {
          return s.placeInRow(gid, groups[gi - 1]!.id, dir === 'right' ? COLUMN_RIGHT : COLUMN_LEFT)
        }
        if (pos === 'solo') return
        const row = packRows(groups).find((r) => r.some((c) => c.some((g) => g.id === gid)))!
        // Выход из секции — шаг влево из ЛЕВОЙ колонки и он же из правой, когда в ней
        // элемент один: переехав, он оставил бы колонку пустой, а секции с пустой
        // колонкой не бывает. Оба случая — takeOwnRow.
        if (dir === 'left' && (pos === 'left' || pos === 'rightSolo')) return s.takeOwnRow(id)
        if (dir === 'right' && pos !== 'left') return // правая колонка — правый край оси
        // Смена колонки: элемент встаёт в КОНЕЦ противоположной стопки — туда же, куда
        // его кладёт жест (placeInRow якорится за последним элементом колонки).
        const other = pos === 'left' ? row[1]! : row[0]!
        s.placeInRow(gid, other.at(-1)!.id, pos === 'left' ? COLUMN_RIGHT : COLUMN_LEFT)
      },

      placeBlockInRow: (activeId, targetId) =>
        commit(null, (s) => {
          if (activeId === targetId) return null
          const groups = groupBlocks(s.blocks)
          const group = groups.find((g) => g.blocks.some((b) => b.id === targetId))
          const active = group?.blocks.find((b) => b.id === activeId)
          const target = group?.blocks.find((b) => b.id === targetId)
          // Ряд внутри вопроса — только пара «подпись + поле ответа» (§6.5), и оба
          // обязаны быть из ОДНОЙ группы: между вопросами работает placeInRow.
          // Whitelist типов не проверяется — отменён (ADR §10).
          if (!group || !active || !target) return null
          if (!isCaptionType(target.type) || !isAnswerableType(active.type)) return null
          if (!innerRowHasFreeCell(s.blocks, targetId)) return null
          // Как и у групп: поле переезжает ВПЛОТНУЮ за подпись (контент между ними
          // разорвал бы пару) и получает бит. Порядок блоков документа при этом
          // меняется — это перенос, а не пометка.
          const rest = group.blocks.filter((b) => b.id !== activeId)
          const at = rest.findIndex((b) => b.id === targetId) + 1
          const reordered: Block[] = [
            ...rest.slice(0, at),
            { ...active, settings: { ...active.settings, column: COLUMN_RIGHT } },
            ...rest.slice(at),
          ]
          const gi = groups.indexOf(group)
          const moved = structural(
            { blocks: groups.flatMap((g, i) => (i === gi ? reordered : g.blocks)) },
            // Смена соседа здесь — по прямой просьбе, а не побочный эффект переноса.
            activeId,
          )!
          // Бит не приземлился — normalizeColumns счёл его инертным; «перенос вплотную
          // за подпись» без ряда не то, о чём просили.
          const landed = moved.blocks.find((b) => b.id === activeId)
          return landed?.settings?.column === COLUMN_RIGHT ? moved : null
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

      addOption: (blockId, label = '') => {
        const option: Option = { id: newOptionId(), label }
        // Тег ub:opt — набор в «призрака» коалесится с последующей правкой этого же
        // варианта в один шаг истории: для автора первый символ и остальные — одно
        // действие, и Ctrl+Z не должен разбирать его по буквам.
        commit(label === '' ? null : `ub:${option.id}:text`, (s) =>
          mutateOptions(s.blocks, blockId, (opts) => [...opts, option]),
        )
        return option.id
      },

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

      duplicateOption: (blockId, optionId) => {
        let copyId: string | null = null
        commit(null, (s) =>
          mutateOptions(s.blocks, blockId, (opts) => {
            const i = opts.findIndex((o) => o.id === optionId)
            if (i < 0) return opts // вариант не найден — тот же массив (no-op)
            // Копия — своя сущность: НОВЫЙ id при том же тексте. Ответы ключуются id
            // варианта, и копия с чужим id молча присвоила бы себе его ответы.
            const copy: Option = { id: newOptionId(), label: opts[i]!.label }
            copyId = copy.id
            const next = opts.slice()
            next.splice(i + 1, 0, copy)
            return next
          }),
        )
        return copyId
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
        commit(null, (s) => {
          const block = s.blocks.find((b) => b.id === blockId)
          if (!block || !isChoiceType(block.type)) return null
          const options = block.settings?.options ?? []
          // Незнакомый вариант — no-op: filter вернул бы новый массив, и удаление
          // «в никуда» стоило бы шага истории и dirty.
          if (!options.some((o) => o.id === optionId)) return null
          // Последний вариант уносит с собой сам блок: choice без вариантов не
          // существует (см. newBlock). Остаётся голая подпись — законное состояние,
          // в которое автор подсаживает любой блок ответа («/» → «Вопросы» или
          // «Отдельные поля», см. captionAwaitingField). Удаление варианта и блока —
          // ОДИН шаг истории: Ctrl+Z возвращает вопрос целиком, а не пустой блок.
          if (options.length === 1) {
            return structural({ blocks: s.blocks.filter((b) => b.id !== blockId) })
          }
          return mutateOptions(s.blocks, blockId, (opts) => opts.filter((o) => o.id !== optionId))
        }),

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

      // Коалесится ТОЛЬКО непрерывный подбор цвета: выборщик зовёт onChange на каждое
      // движение мыши, и без общего тега один жест дал бы сотню шагов отмены. Всё
      // остальное — появление обложки, снятие, смена картинки — свой шаг: это разные
      // намерения автора, и склеивать их в один Mod+Z нельзя.
      //
      // Коалесинг тут такой же «липкий», как у набора текста: два подбора цвета
      // подряд, между которыми автор ничего больше не делал, сольются в один шаг —
      // тег держится до первого действия с другим тегом. Это ровно то же поведение,
      // что у правок текста блока (updateBlockTag), и заводить ему исключение
      // значило бы объяснять, почему у цвета обложки история дробится мельче.
      setCover: (cover) =>
        commit(cover?.color && get().cover?.color ? 'cc' : null, (s) =>
          s.cover === cover ? null : { cover },
        ),
      setLogo: (logo) => commit(null, (s) => (s.logo === logo ? null : { logo })),

      // Тег null: жест перетаскивания коммитится сюда ОДИН раз, на отпускании, —
      // коалесить внутри жеста нечего, а два жеста подряд обязаны остаться двумя
      // шагами отмены (тег держится «липко», до первого действия с другим тегом,
      // и склеил бы их).
      //
      // Сдвиг осмыслен только у картинки: у цвета двигать нечего, а схема такой
      // документ отвергает (422). Обложки нет вовсе — тем более no-op.
      setCoverY: (y) =>
        commit(null, (s) =>
          !s.cover?.imageKey || s.cover.y === y ? null : { cover: { ...s.cover, y } },
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
        // Ключа нет, когда оформления нет: пустой объект контракт отвергает (422).
        ...(get().cover ? { cover: get().cover } : {}),
        ...(get().logo ? { logo: get().logo } : {}),
      }),
    }
  })
}
