import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Asterisk, GripVertical, Plus, Trash2 } from 'lucide-react'
import {
  type Block,
  isCaptionType,
  isSingleChoiceType,
  isContentType,
  plainText,
  supportsPlaceholder,
  type Span,
} from '@entities/formSchema'
import { optionKey } from '@fields/answer'
import { packOptionRows } from '@fields/groups'
import { filterMenuItems, type MenuItem } from './blockTypes'
import { rowFacts } from './kinds/index'
import { FIELD_CLS, FieldWrap } from './kinds/fieldWrap'
import { noLayoutAnimation } from './dnd'
import { useBuilderStore } from './storeContext'
import type { UpdateKind } from './store'
import { useFocusEngine, useRegisterFocusTarget } from './focusEngine'
import { useCaptionGuard } from './captionGuard'
import { textCaret } from './caret'
import { RichLine } from './RichLine'
import { richCaret } from './richCaret'
import { cutRange } from './richText'
import { SlashMenu } from './SlashMenu'
import { BlockActionMenu } from './BlockActionMenu'
import { arrowDir, chords } from './shortcuts'
import { useRowFocus } from './activeRow'
import { CaptionChip } from './CaptionChip'

export interface BlockRowProps {
  block: Block
  // formId нужен image-блоку для загрузки картинки (POST /forms/{id}/media).
  formId: string
  // groupHandle — attributes+listeners sortable-элемента ГРУППЫ (внешний уровень
  // dnd): грип этой строки тащит всю группу, а не сам блок. Ставится родителем
  // только на подпись мульти-группы («подпись владеет группой»). null/undefined —
  // грип тащит блок (блочный слой dnd: одиночки и внутренние строки).
  groupHandle?: Pick<ReturnType<typeof useSortable>, 'attributes' | 'listeners'> | null
  // groupHasAnswer — есть ли в группе строки отвечаемый блок. Нужен подсказкам: без
  // него Mod+Enter («к полю ответа») молчит, и обещать его нельзя (§7).
  groupHasAnswer?: boolean
  // requiredFor — блок, чью обязательность представляет эта строка (носитель флага —
  // всегда отвечаемый блок, модель не меняется). У поля это оно само, у первой
  // подписи группы — поле её вопроса, у контента — ничего.
  //
  // Звёздочку рисует подпись, а не поле (решение владельца 2026-07-26): у превью и
  // рендерера она и так на подписи (§6). У группы без подписи звёздочка остаётся на
  // самом поле — больше негде. Кому её показывать, решает GroupRow: он знает состав
  // группы, а строка — только себя.
  requiredFor?: Block
  // Позиция строки на полотне — для плейсхолдеров пустой строки (§7, слой 1: «тип
  // блока × позиция»). insideQuestion — строка внутри вопроса, но не его подпись
  // (там пустой текст = описание вопроса); firstOfForm — самая первая строка полотна
  // (там пустой текст = начало формы, и подсказка зовёт добавить вопрос).
  insideQuestion?: boolean
  firstOfForm?: boolean
  // mirrored — строка стоит в ПРАВОЙ колонке ряда (спека §5): кластер значков
  // зеркалится в правое поле (левый лёг бы в 28px-жёлоб между колонками и наехал
  // на соседнюю группу), тогл обязательности остаётся у правого края текста.
  mirrored?: boolean
  // rowZone — зона жеста «встань в ряд со мной» на ЭТОЙ строке (фаза 15, §6.6):
  // absolute-оверлей, который полотно зажигает, пока тащат подходящее поле её группы.
  // Приходит готовым узлом: строка о droppable'ах и правилах dnd не знает, её дело —
  // дать absolute-якорь (root уже relative). Вне потока и pointer-events-none — как
  // и весь появляющийся по драгу декор (урок TD-22).
  rowZone?: ReactNode
  // needsCaption — строка ответа стоит без заголовка. С фазы 15 это ЗАКОННОЕ
  // состояние (правило requiresCaption понижено до правила вставки, §4.4 спеки), и
  // вместо сопротивления строка предлагает недостающее действие: чип «Mod+Alt+T —
  // Заголовок», по которому можно и кликнуть. Считает GroupRow — состав группы знает
  // он; исключены contentные типы и consent (его текст и есть строка вопроса).
  needsCaption?: boolean
  // openMenuOnMount — строку создали по «/» или «+»: сразу открыть меню выбора типа.
  openMenuOnMount: boolean
  // onAddBelow — новая текстовая строка. Enter — после всей группы; Shift+Enter
  // (opts.inside) — внутрь группы под текущей строкой; с объектной остановки — засев
  // (печатный символ/вставка → seed) или открытие меню («/»).
  onAddBelow: (id: string, opts?: { openMenu?: boolean; seed?: string; inside?: boolean }) => void
  // onInsertBelow — кнопка «+»: новая строка с открытым меню выбора типа.
  onInsertBelow: (id: string) => void
  // onBackspaceAtStart — Backspace в начале блока: удалить картинку-соседа сверху или
  // схлопнуть пустой блок в предыдущий (решает родитель — знает соседей).
  onBackspaceAtStart: (id: string) => void
  // onBackspaceDelete — Backspace на поверхности БЕЗ собственного текста: объектной
  // остановке (image/date/scale) или пустом инпуте плейсхолдера. Удаляет блок и
  // уводит каретку на предыдущую остановку/заголовок (§2.2, знает соседей).
  // Поведение единое для всех поверхностей ответа (решение владельца 2026-07-26):
  // «стёрли ответ» — это вопрос без поля, а не поле с пустотой внутри. У choice то
  // же самое делает Backspace в последнем пустом варианте (removeOption).
  onBackspaceDelete: (id: string) => void
  // onDeleteBlock — Cmd+Shift+Backspace (§3.4): явное удаление блока/группы + тост,
  // исход фокуса по контракту (решает родитель — знает соседей и владение группой).
  onDeleteBlock: (id: string) => void
  // onAnswerAction — Cmd/Ctrl+Enter (§3.2): прыжок к контролу ответа группы (решает
  // родитель — знает состав группы). На картинке файловый диалог открывает ObjectStop.
  onAnswerAction: (id: string) => void
  onArrow: (id: string, dir: 'up' | 'down') => void
  // Mod+Alt+→/← — перенос вопроса в правую ячейку ряда и обратно (§5). Цель выбирает
  // полотно (знает соседей), строка только сообщает о жесте.
  onRowShift: (id: string, dir: 'left' | 'right') => void
}

// BlockRow — одна строка полотна в стиле Tally: слева в поле — ручка перетаскивания
// (dnd) и «+», по центру редактируемый заголовок и живое превью поля, справа —
// меню действий и удаление. Клавиатура: Enter — новый блок, «/» — меню типов,
// Backspace в пустом — удалить и уйти на предыдущий, ↑/↓ на границе — переход,
// Alt+↑/↓ — перемещение.
export function BlockRow({
  block,
  formId,
  groupHandle,
  groupHasAnswer = false,
  requiredFor,
  insideQuestion = false,
  firstOfForm = false,
  mirrored = false,
  rowZone,
  needsCaption = false,
  openMenuOnMount,
  onAddBelow,
  onInsertBelow,
  onBackspaceAtStart,
  onBackspaceDelete,
  onDeleteBlock,
  onAnswerAction,
  onArrow,
  onRowShift,
}: BlockRowProps) {
  const engine = useFocusEngine()
  // Обёртка структурных команд, называющая потерю заголовка (§4.3 спеки фазы 15):
  // строка теперь двигается и удаляется отдельно от своего вопроса, и каждый такой
  // жест может оставить поле без имени в выгрузке. Зовут её ровно те обработчики,
  // которые правят СОСТАВ документа, — набор текста и смена типа сюда не входят.
  const captionGuard = useCaptionGuard(engine)
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const moveBlock = useBuilderStore((s) => s.moveBlock)
  const moveGroup = useBuilderStore((s) => s.moveGroup)
  const removeBlock = useBuilderStore((s) => s.removeBlock)
  const removeGroup = useBuilderStore((s) => s.removeGroup)
  const changeBlockType = useBuilderStore((s) => s.changeBlockType)
  const makeQuestion = useBuilderStore((s) => s.makeQuestion)
  const makeField = useBuilderStore((s) => s.makeField)
  const duplicateBlock = useBuilderStore((s) => s.duplicateBlock)
  const addCaptionFor = useBuilderStore((s) => s.addCaptionFor)
  // Текстовая поверхность строки: <textarea> либо (проба 14.0) contenteditable. Тип
  // union, потому что поток строки с ней говорит только через адаптер каретки и о её
  // природе не знает — ровно ради этого адаптер и вводился (§2.6 спеки фазы 13).
  const labelRef = useRef<HTMLTextAreaElement | HTMLDivElement>(null)
  // Инлайн-слеш (§3.5): «/» остаётся литералом в тексте, меню открывается поверх и
  // фильтруется продолжением набора. slash — null (закрыто) либо {start, query}:
  // start — индекс «/» в тексте, query — набранное после него (до каретки). Строку,
  // рождённую по «/» (openMenuOnMount), стор засевает текстом «/», поэтому меню
  // открыто с монтирования на позиции 0. slashActive — подсвеченный пункт (индекс в
  // отфильтрованном списке).
  const [slash, setSlash] = useState<{ start: number; query: string } | null>(
    openMenuOnMount ? { start: 0, query: '' } : null,
  )
  const [slashActive, setSlashActive] = useState(0)
  const slashList = slash ? filterMenuItems(slash.query) : []
  // Меню действий блока (Cmd+. §3.3): открыто ли.
  const [actionOpen, setActionOpen] = useState(false)
  // Текстовая строка в фокусе. Нужно ровно одному: плейсхолдер обычного текста
  // виден только у активной строки, иначе полотно пестрит серым (§7, слой 1).
  const [labelFocused, setLabelFocused] = useState(false)
  // Подсказки (§7): текстовая поверхность объявляет свой контекст карты — от него
  // зависят чипы у каретки и шпаргалка Mod+/. Остальные поверхности строки (варианты,
  // инпут плейсхолдера, объектная остановка) объявляют свой контекст сами.
  // movesRow: у подписи вопроса (она несёт групповую ручку) Alt+↑↓ двигает вопрос
  // целиком, а не строку, — пункт «Переместить блок» из подсказок выпадает, перенос
  // вопроса остаётся обещан отдельным Alt+Shift+↑↓. У ВСЕХ прочих строк, включая
  // строку ответа собранного вопроса, жест двигает саму строку (фаза 15, §4.1).
  const movesRow = !groupHandle
  const textFocus = useRowFocus(block.id, 'text', groupHasAnswer, movesRow)
  // Плейсхолдер пустой строки — подсказка в самом месте каретки (§7, слой 1). У
  // подписей он от позиции не зависит (тип уже сказал, что это) и виден всегда; у
  // обычного текста зависит и показывается только под кареткой: неактивная пустая
  // строка молчит, иначе полотно пестрит серым текстом.
  const textPh = insideQuestion
    ? // Пустой текст внутри вопроса — это его описание, а не новый блок.
      'Пояснение к вопросу'
    : firstOfForm
      ? // Первая строка формы: «/» здесь чаще всего зовут ради вопроса, а не поля.
        'Текст, или «/» — чтобы добавить вопрос'
      : 'Текст, или «/» для поля'
  // Имя строки, её классы и глиф — факты типа (kinds/<type>.tsx, row). У абзаца имя
  // ПОЗИЦИОННОЕ (name: null): пустая строка значит разное в разных местах документа,
  // поэтому оно берётся из подсказки места — это отношение, а не свойство типа.
  //
  // row === null не бывает: единственный такой тип — заголовок формы, а его рисует
  // FormTitleRow (SlashEditor отделяет его splitFormTitle ещё до списка строк).
  const row = rowFacts(block.type)
  const isTextRow = row?.surface === 'text'
  const captionName = (isTextRow ? row.name : null) ?? textPh
  // Подсказка абзаца видна только под фокусом, а ИМЯ строки мигать не должно.
  const captionPh =
    isTextRow && row.placeholderOnFocusOnly
      ? labelFocused
        ? captionName
        : undefined
      : captionName
  const isContent = isContentType(block.type)
  const isConsent = isTextRow && row.mark === 'check'
  // hasTextLine — у блока есть редактируемая строка текста: подписи/контент и consent.
  // Поля ввода строки не несут — их подпись живёт отдельным блоком.
  const hasTextLine = isTextRow
  const captionCls = isTextRow ? row.className : ''

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    // Без «доигрывания» анимации после дропа (отскок к старой позиции) — см. dnd.ts.
    // У строк артефакт проявлялся при переносе ВНУТРИ группы (без ремаунта).
    animateLayoutChanges: noLayoutAnimation,
  })
  // Translate, а не Transform: блоки разной высоты, и dnd-kit кладёт в transform
  // scaleY, чтобы переносимый блок «подгонялся» под высоту соседнего слота — из-за
  // этого он визуально сжимался/растягивался при перетаскивании. Translate.toString
  // берёт только сдвиг (translate3d), scaleX/scaleY отбрасывает — блок сохраняет
  // свою высоту. Смещение соседей (scale=1) от этого не страдает.
  const style = { transform: CSS.Translate.toString(transform), transition }

  // caret — адаптер каретки поверх textarea строки (§2.6) или null (у строки нет
  // textarea). Строится от АКТУАЛЬНОГО элемента: identity textarea могла смениться
  // при ре-рендере, поэтому не кэшируем сам адаптер.
  const caret = useCallback(() => {
    const el = labelRef.current
    if (!el) return null
    return el instanceof HTMLTextAreaElement ? textCaret(el) : richCaret(el)
  }, [])

  // Регистрация фокус-цели строки в фокус-движке (§2.5): текстовые строки дают цель
  // каретки, и движок ставит на них фокус по focusBlock(id). Строки-поля/варианты/
  // объекты регистрируют свои цели сами (AnswerField/OptionsInline/ObjectStop ниже).
  useRegisterFocusTarget(block.id, (edge) => caret()?.focus(edge), hasTextLine)

  useEffect(() => {
    caret()?.autosize()
  }, [caret, block.text])

  // Биндинги по e.code (§3.1): физическая клавиша не зависит от раскладки. «/» не
  // перехватывается — уходит в текст литералом (§3.5), меню ведёт onLabelChange.
  function onLabelKeyDown(e: KeyboardEvent<HTMLElement>) {
    // Адаптер строки, а не textCaret(e.currentTarget): поверхность может быть и
    // contenteditable (проба 14.0), а поток о ней знать не должен.
    const c = caret()
    if (!c) return
    // Открытый инлайн-слеш забирает навигацию: ↑/↓ — по пунктам, Enter — выбор,
    // Esc — закрыть (текст остаётся). Backspace отдаём нативному вводу (удаляет символ,
    // onLabelChange пересчитает/закроет фильтр) — иначе на «/» в начале строки
    // сработало бы схлопывание блока. Печать проваливается в текст и фильтрует.
    if (slash) {
      if (chords.arrowDown(e)) {
        e.preventDefault()
        return setSlashActive((i) => (slashList.length ? (i + 1) % slashList.length : 0))
      }
      if (chords.arrowUp(e)) {
        e.preventDefault()
        return setSlashActive((i) =>
          slashList.length ? (i - 1 + slashList.length) % slashList.length : 0,
        )
      }
      if (chords.enter(e)) {
        e.preventDefault()
        const item = slashList[slashActive]
        if (item) pickSlash(item)
        return
      }
      if (chords.escape(e)) {
        e.preventDefault()
        return closeSlash()
      }
      if (chords.backspace(e)) return
    }
    if (chords.actionMenu(e)) {
      e.preventDefault()
      setActionOpen(true)
    } else if (chords.deleteBlock(e)) {
      e.preventDefault()
      onDeleteBlock(block.id)
    } else if (chords.answerAction(e)) {
      // Cmd/Ctrl+Enter — к контролу ответа группы (§3.2). Проверяем ДО простого Enter.
      e.preventDefault()
      onAnswerAction(block.id)
    } else if (chords.moveGroup(e)) {
      // Alt+Shift+↑/↓ — перенос ГРУППЫ целиком (§3.2). Проверяем ДО Alt-переноса блока.
      // Каретка остаётся на месте: id блока стабилен, groupId от перестановки не
      // меняется (regroup якорит по id), строка не перемонтируется.
      e.preventDefault()
      moveGroup(block.id, arrowDir(e))
    } else if (chords.rowRight(e) || chords.rowLeft(e)) {
      // Mod+Alt+→/← — в ряд с предыдущим вопросом и обратно (§5). Каретка едет с
      // блоком по той же причине, что у moveGroup: id стабилен, ремаунта нет.
      e.preventDefault()
      onRowShift(block.id, chords.rowRight(e) ? 'right' : 'left')
    } else if (chords.enter(e)) {
      // Enter — новый блок после группы; Shift+Enter — внутрь группы (§3.2).
      e.preventDefault()
      onAddBelow(block.id, { inside: e.shiftKey })
    } else if (chords.backspace(e) && c.caretAtStart()) {
      // Каретка схлопнута в начале блока. Решение принимает родитель (знает соседей):
      // предыдущий блок — картинка → удалить её (как Backspace перед элементом в
      // текстовом документе), иначе пустой текущий блок схлопнуть в предыдущий. Дефолт
      // гасим всегда — нативный Backspace в начале блока и так ничего не делает.
      e.preventDefault()
      onBackspaceAtStart(block.id)
    } else if (chords.moveItem(e)) {
      e.preventDefault()
      captionGuard(() => moveBlock(block.id, arrowDir(e)))
    } else if (chords.arrowUp(e) && c.caretAtStart()) {
      e.preventDefault()
      onArrow(block.id, 'up')
    } else if (chords.arrowDown(e) && c.caretAtEnd()) {
      e.preventDefault()
      onArrow(block.id, 'down')
    }
  }

  function pickType(item: MenuItem) {
    // «Вопросы» → бандл подпись+поле; «Отдельные поля» → голое поле; и то, и другое
    // одиночный блок конвертирует на месте, а внутри группы — новой группой ниже
    // (инпут не встраивается между подписью и контролом). «Лэйаут» → тип на месте.
    // Фокус — на ВОЗВРАЩЁННЫЙ сторами id (§2.4, Д2): поверхность нового/сконвертиро-
    // ванного блока (подпись бандла, инпут поля, объектная остановка image/date/scale).
    // eager-text под картинкой больше не заводим — вставка объекта это один шаг undo,
    // каретка встаёт на сам объект (§2.3).
    const focusId =
      item.group === 'question'
        ? makeQuestion(block.id, item.type)
        : item.group === 'field'
          ? makeField(block.id, item.type)
          : changeBlockType(block.id, item.type)
    setSlash(null)
    engine.focusBlock(focusId, 'end')
  }

  const closeSlash = () => setSlash(null)

  // Выбор типа из инлайн-слеша: сначала вырезаем из текста «/» и набранный фильтр
  // (§3.5), затем применяем тип. Обе правки — updateBlock({text}), они коалесятся с
  // предыдущим набором в один шаг истории (тег ub:id:text), поэтому лишнего шага
  // undo вырезание не добавляет. changeBlockType/makeQuestion читают уже очищенный
  // текст из стора (подпись поля = то, что осталось), см. pickType.
  //
  // Вырезание идёт через `restyle` по координатам плоского текста, а не склейкой строк:
  // «/» и фильтр могли быть набраны внутри размеченного куска, и подъём строки заново
  // стёр бы оформление всей подписи.
  function pickSlash(item: MenuItem) {
    if (slash) {
      const end = slash.start + 1 + slash.query.length
      updateBlock(block.id, { text: cutRange(block.text ?? [], slash.start, end) })
    }
    pickType(item)
  }

  // onChange текстовой строки: ведёт инлайн-слеш (§3.5). Открытое меню — пересчитываем
  // фильтр от каретки; каретка ушла за «/», там пробел/перенос, или ни один тип не
  // совпал — закрываем, текст (включая «/») остаётся. Меню закрыто — «/» прямо перед
  // кареткой открывает его на ЛЮБОМ неотвечаемом блоке (isContent: подписи title/label,
  // heading, абзац text), а не только на абзаце. Не открывает на consent: тот текст
  // несёт, но отвечаем — «/» там литерал. Печать всегда идёт в текст.
  // Принимает уже разобранную МОДЕЛЬ и позицию каретки в плоском тексте, а не событие:
  // логика слеша живёт в координатах текста и о поверхности ничего не знает — ровно
  // поэтому переход textarea → contenteditable её не переписал.
  function onLabelChange(spans: Span[], pos: number, kind?: UpdateKind) {
    updateBlock(block.id, { text: spans }, kind)
    const value = plainText(spans)
    if (slash) {
      if (pos <= slash.start || value[slash.start] !== '/') return closeSlash()
      const query = value.slice(slash.start + 1, pos)
      if (/\s/.test(query) || filterMenuItems(query).length === 0) return closeSlash()
      setSlash({ start: slash.start, query })
      setSlashActive(0)
    } else if (isContent && pos > 0 && value[pos - 1] === '/') {
      setSlash({ start: pos - 1, query: '' })
      setSlashActive(0)
    }
  }

  // Дать голой строке ответа заголовок (§4.4 спеки фазы 15) — одно действие на два
  // входа: клавиша строки и клик по чипу. Каретка уходит на новую подпись: автор
  // позвал этот жест, чтобы её написать.
  function addCaption() {
    const id = addCaptionFor(block.id)
    if (id) engine.focusBlock(id, 'end')
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Строке с заголовком жест не обещан (чипа нет) — и не делается: no-op без шага
    // истории, а не тихое «ничего не произошло» после коммита.
    if (!needsCaption || !chords.addCaption(e)) return
    e.preventDefault()
    addCaption()
  }

  const iconBtn =
    'flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground'

  // Высота кластеров значков = line-height ПЕРВОЙ строки блока (объявлена типом,
  // fields.css — источник самих чисел): вопрос и заголовок раздела 28px (h-7), остальное
  // 24px (h-6). Кластеры absolute и центрируют значок по своей высоте, поэтому только так
  // они стоят на уровне текста.
  const rowLineH = row?.lineH ?? 'h-6'

  return (
    <div
      ref={setNodeRef}
      style={style}
      // data-block-id — якорь для замера строки драг-рамкой (updateFrame в
      // SlashEditor): getBoundingClientRect по нему учитывает live-трансформы.
      data-block-id={block.id}
      // py-1.5 — вертикальная hover-зона строки (место под absolute-значки), но в
      // поток она НЕ входит: -my-1.5 гасит её ровно на padding, поэтому flex-gap
      // контейнеров группы (14px) и полотна (28px) остаётся чистым просветом контента
      // и совпадает с превью (ритм 13.3). Значки центрируются по top-1.5 = padding →
      // на первой строке текста. Меняешь padding — правь -my И top-1.5 значков.
      // Mod+Alt+T слушает СТРОКА, а не каждая её поверхность: жест относится ко всей
      // строке (дать ей заголовок), а поверхностей у неё несколько — инпут
      // плейсхолдера, объектная остановка, инпуты вариантов. Событие всплывает от
      // любой из них, и ни одна этот аккорд не перехватывает.
      onKeyDown={onRowKeyDown}
      className={`group relative rounded-md -my-1.5 py-1.5 ${isDragging ? 'z-10 opacity-70' : ''}`}
    >
      {rowZone}
      {/* Меню действий блока (Cmd+. §3.3): якорь — нулевой span в левом absolute-поле
          строки, сам поповер порталится. onPickType — тот же pickType, что у слеш-меню
          (makeQuestion/makeField/changeBlockType + фокус на результат). */}
      <BlockActionMenu
        open={actionOpen}
        onOpenChange={setActionOpen}
        block={block}
        anchor={<span aria-hidden="true" className="pointer-events-none absolute left-0 top-1.5" />}
        // Обязательность меню правит там же, где звёздочка, — в отвечаемом блоке
        // группы. Поэтому на подписи вопроса пункт есть (раньше не было: подпись
        // ответов не собирает, а флаг — как раз про её вопрос).
        requiredFor={requiredFor}
        onToggleRequired={() =>
          requiredFor && updateBlock(requiredFor.id, { required: !requiredFor.required })
        }
        onDuplicate={() => duplicateBlock(block.id)}
        onDelete={() => onDeleteBlock(block.id)}
        onPickType={pickType}
      />

      {/* Все элементы управления — в левом поле (вне колонки текста, absolute), поэтому
          сам текст остаётся по центру колонки. Проявляются по hover/фокусу строки;
          высота кластера = line-height первой строки блока (rowLineH) + items-center
          → значки на уровне текста. Порядок: удалить, добавить, перетащить (ручка
          последняя = ближайшая к тексту).

          Кластер absolute и проявляется через opacity — высоту строки он не меняет
          НИКОГДА, и это здесь не косметика, а требование корректности. Контрол,
          который появляется по hover/фокусу и при этом занимает место в потоке,
          схлопывается синхронно на mousedown (фокус уходит из блока → блок теряет
          :focus-within → высота падает): всё, что ниже, уезжает вверх, mouseup
          приходит уже мимо цели, и браузер диспатчит click на общего предка —
          обработчик кнопки не срабатывает. Так «+ Описание» (контрол тех времён,
          сейчас его нет), стоявшее в потоке под заголовком, съедало первый клик по
          «+ Добавить блок» — TD-22.
          Любой новый reveal-on-hover контрол блока — только сюда. */}
      {/* tabIndex=-1 у значков строки: полотно — один Tab-stop, кнопки-значки —
          мышиные удобства и выпадают из Tab-обхода (§3.1). Клавиатурные эквиваленты —
          шорткаты (Alt+↑/↓ — перенос) и меню действий Cmd+. (13.2).

          Кластер есть у КАЖДОЙ строки, включая строку ответа в собранном вопросе
          (фаза 15, §4.1 спеки): удалить поле отдельно, вставить блок между подписью
          и полем, утащить поле из своего вопроса — законные действия, а не «действия,
          которых не бывает», как считал снятый замок. У вариантов choice поверх этого
          свои кластеры (см. OptionCard). */}
      <div
        // mr-2.5 (не mr-1): между кластером и текстом живёт рейл группы (-left-2,
        // GroupRow) — значки отодвинуты, чтобы грип не ложился на линию.
        // mirrored (правая колонка ряда): кластер уезжает в ПРАВОЕ поле, за
        // тогл обязательности (тот стоит на left-full ml-1, ширина 24px → ml-7).
        className={`absolute top-1.5 flex ${
          mirrored ? 'left-full ml-7 flex-row-reverse' : 'right-full mr-2.5'
        } ${rowLineH} items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100`}
      >
        <button
          type="button"
          tabIndex={-1}
          onClick={() =>
            captionGuard(() =>
              isCaptionType(block.type) ? removeGroup(block.id) : removeBlock(block.id),
            )
          }
          aria-label={isCaptionType(block.type) ? 'Удалить вопрос (группу)' : 'Удалить блок'}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onInsertBelow(block.id)}
          aria-label="Добавить блок ниже (выбрать тип)"
          className={iconBtn}
        >
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          {...(groupHandle ? groupHandle.attributes : attributes)}
          {...(groupHandle ? groupHandle.listeners : listeners)}
          // После спреда: dnd-kit кладёт в attributes свой tabIndex=0 — перебиваем на
          // -1, чтобы грип выпал из Tab (перенос с клавиатуры — Alt+↑/↓, не Space-драг).
          tabIndex={-1}
          aria-label={
            groupHandle && isCaptionType(block.type)
              ? 'Перетащить вопрос (группу)'
              : 'Перетащить блок'
          }
          className={`${iconBtn} cursor-grab active:cursor-grabbing`}
        >
          <GripVertical className="size-4" />
        </button>
      </div>

      {/* Обязательность — в правом поле блока (за колонкой вопроса), зеркально
          левому кластеру значков. Показывает её ПОДПИСЬ вопроса (как превью и
          рендерер, §6), а пишет в отвечаемый блок группы — носитель флага не менялся.
          У группы без подписи звёздочка остаётся на самом поле: показать её больше
          негде. Контент ответов не собирает — там её нет вовсе. */}
      {requiredFor ? <RequiredToggle block={requiredFor} lineH={rowLineH} /> : null}

      {/* Единственная подсказка, оставшаяся у строки (решение владельца 2026-07-29):
          голой строке ответа предлагается дать заголовок. Прочие чипы сняты — карта
          клавиш целиком живёт в шпаргалке Mod+/. Компонент сам решает, рисовать ли
          себя (каретка на этой строке), и ничего не рисует, когда её здесь нет. */}
      {needsCaption && (
        <CaptionChip rowId={block.id} lineH={rowLineH} onAddCaption={addCaption} />
      )}

      {/* Поверхность строки по типу (§2.1): текстовая (подписи/контент/consent) —
          textarea со слеш-меню; choice — инпуты вариантов; текстовые поля —
          инпут плейсхолдера; image/date/scale — объектная остановка (§2.2).
          Каждая ветка регистрирует свою фокус-цель в движке. */}
      {hasTextLine ? (
        <SlashMenu
          open={slash !== null}
          items={slashList}
          activeIndex={slashActive}
          onActiveChange={setSlashActive}
          onPick={pickSlash}
          onClose={closeSlash}
        >
          <div className="min-w-0">
            <div className={isConsent ? 'flex items-start gap-2' : undefined}>
              {isConsent && (
                <span className="rf-mark rf-mark--check mt-0.5 shrink-0" aria-hidden="true" />
              )}
              <RichLine
                elRef={(el) => {
                  labelRef.current = el
                }}
                value={block.text ?? []}
                placeholder={captionPh}
                label={captionName}
                onChange={onLabelChange}
                onFocus={() => {
                  setLabelFocused(true)
                  textFocus.onFocus()
                }}
                onBlur={(e) => {
                  setLabelFocused(false)
                  textFocus.onBlur(e)
                }}
                onKeyDown={onLabelKeyDown}
                className={`block w-full bg-transparent outline-none ${captionCls}`}
              />
            </div>
          </div>
        </SlashMenu>
      ) : row?.surface === 'choice' ? (
        <div className="min-w-0">
          <OptionsInline
            block={block}
            mirrored={mirrored}
            onLeaveTop={() => onArrow(block.id, 'up')}
            onArrow={onArrow}
            onAddBelow={onAddBelow}
            onDeleteBlock={onDeleteBlock}
            onBackspaceDelete={onBackspaceDelete}
            onOpenActions={() => setActionOpen(true)}
            onRowShift={(dir) => onRowShift(block.id, dir)}
          />
        </div>
      ) : row?.surface === 'placeholder' ? (
        <div className="min-w-0">
          <AnswerField
            block={block}
            insideQuestion={insideQuestion}
            onArrow={onArrow}
            onBackspaceDelete={onBackspaceDelete}
            onDeleteBlock={onDeleteBlock}
            onOpenActions={() => setActionOpen(true)}
            onMove={(dir) => captionGuard(() => moveBlock(block.id, dir))}
            onRowShift={(dir) => onRowShift(block.id, dir)}
          />
        </div>
      ) : (
        // Объектная остановка — фокусируемая строка с кольцом (§2.2): картинка, дата,
        // шкала. Что стоит внутри, объявляет сам тип (row.Control), поэтому карты
        // «тип → контрол» здесь больше нет.
        <ObjectStop
          block={block}
          insideQuestion={insideQuestion}
          onAddBelow={onAddBelow}
          onBackspaceDelete={onBackspaceDelete}
          onArrow={onArrow}
          onDeleteBlock={onDeleteBlock}
          onOpenActions={() => setActionOpen(true)}
          onMove={(dir) => captionGuard(() => moveBlock(block.id, dir))}
          onMoveGroup={(dir) => moveGroup(block.id, dir)}
          onRowShift={(dir) => onRowShift(block.id, dir)}
        >
          {row?.surface === 'object' && <row.Control block={block} formId={formId} />}
        </ObjectStop>
      )}
    </div>
  )
}

// RequiredToggle — контрол обязательности в правом поле блока (absolute left-full),
// зеркально левому кластеру значков. Это редактируемый контрол, а не индикатор:
// совпадать видом с звёздочкой rf-required рендерера не обязан, только менять
// block.required. Включённым виден всегда и подсвечен (показывает состояние),
// выключенным — проявляется на hover/фокусе строки. Настоящий <button aria-pressed>
// в Tab-обходе; текст состояния — в title/aria-label (значок компактен, как слева).
// lineH — высота строки блока (h-6/h-7), приходит из BlockRow: значок обязан стоять
// на уровне первой строки текста, а она разной высоты у вопроса и у согласия.
function RequiredToggle({ block, lineH }: { block: Block; lineH: string }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const required = block.required
  return (
    <div
      className={`absolute left-full top-1.5 ml-1 flex ${lineH} items-center transition-opacity ${
        required
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
      }`}
    >
      <button
        type="button"
        aria-pressed={required}
        aria-label={required ? 'Обязательный вопрос' : 'Сделать вопрос обязательным'}
        title={required ? 'Обязательный вопрос' : 'Сделать обязательным'}
        onClick={() => updateBlock(block.id, { required: !required })}
        className={`flex size-5 items-center justify-center rounded hover:bg-muted ${
          required ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <Asterisk className="size-4" />
      </button>
    </div>
  )
}


// ObjectStop — объектная остановка строки-объекта (image/date/scale): у неё нет
// текстовой поверхности, поэтому «каретка стоит на объекте» — это фокус на самой
// строке-обёртке с подсветкой кольцом (§2.1–2.2). Печать/вставка не проваливаются:
// печатный символ или вставка засевают text-блок ниже, Enter — пустую строку, «/» —
// строку с меню, Backspace — удаляет объект. tabIndex=-1: остановка достижима
// стрелками и focusBlock, но не Tab (полотно — один Tab-stop, §3.1 / срез roving).
function ObjectStop({
  block,
  insideQuestion = false,
  children,
  onAddBelow,
  onBackspaceDelete,
  onDeleteBlock,
  onOpenActions,
  onArrow,
  onMove,
  onMoveGroup,
  onRowShift,
}: {
  block: Block
  // Строка не первая в группе: Mod+Alt+→ собирает ряд со своим заголовком, а не с
  // предыдущим вопросом (§6.6) — карта обязана называть то, что клавиша делает.
  insideQuestion?: boolean
  children: ReactNode
  onAddBelow: (id: string, opts?: { openMenu?: boolean; seed?: string; inside?: boolean }) => void
  onBackspaceDelete: (id: string) => void
  onDeleteBlock: (id: string) => void
  onOpenActions: () => void
  onArrow: (id: string, dir: 'up' | 'down') => void
  onMove: (dir: 'up' | 'down') => void
  onMoveGroup: (dir: 'up' | 'down') => void
  onRowShift: (dir: 'left' | 'right') => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useRegisterFocusTarget(block.id, () => ref.current?.focus())
  // Контекст подсказок: у картинки Mod+Enter открывает файловый диалог, у date/scale
  // открывать нечего — это разные контексты карты, а не один «объект» (§7).
  // Объектная остановка групповой ручки не несёт никогда (первая строка мульти-группы
  // — всегда подпись, regroup ищет её от поля вверх через контент), поэтому Alt+↑↓
  // здесь двигает саму строку: movesRow дефолтный.
  // insideQuestion меняет ПОДПИСЬ пункта Mod+Alt+→ в карте: на не первой строке
  // группы аккорд собирает ряд со своим заголовком, а не с предыдущим вопросом (§6.6).
  // Контекст подсказок объявляет сам тип (row.hint): у картинки Mod+Enter открывает
  // файловый диалог, у даты и шкалы открывать нечего — это разные контексты карты, а не
  // один «объект» (§7).
  const objectRow = rowFacts(block.type)
  const rowFocus = useRowFocus(
    block.id,
    objectRow?.surface === 'object' ? objectRow.hint : 'object',
    false,
    true,
    insideQuestion,
  )

  // Биндинги по e.code (§3.1). «/» остаётся символьным (открыть меню типов у строки
  // ниже) — как и в текстовой строке.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Перехватываем клавиши, только когда фокус на самой остановке, а не во
    // внутреннем контроле (select шкалы, кнопки картинки) — тем нужны свои клавиши.
    if (e.target !== e.currentTarget) return
    if (chords.actionMenu(e)) {
      e.preventDefault()
      onOpenActions()
    } else if (chords.deleteBlock(e)) {
      e.preventDefault()
      onDeleteBlock(block.id)
    } else if (chords.answerAction(e)) {
      // Cmd/Ctrl+Enter — «действие над объектом» (§3.2): на картинке открыть файловый
      // диалог (клик по скрытому input внутри остановки). У date/scale входного файла
      // нет — селектор ничего не найдёт, жест — no-op.
      e.preventDefault()
      ref.current?.querySelector<HTMLInputElement>('input[type="file"]')?.click()
    } else if (chords.moveGroup(e)) {
      e.preventDefault()
      onMoveGroup(arrowDir(e))
    } else if (chords.rowRight(e) || chords.rowLeft(e)) {
      // Mod+Alt+→/← — ряд (§5): у объектной остановки (date/scale/картинка в вопросе)
      // жест тот же, что на подписи — переносится ВОПРОС, а не строка.
      e.preventDefault()
      onRowShift(chords.rowRight(e) ? 'right' : 'left')
    } else if (chords.moveItem(e)) {
      // Alt+↑↓ двигает саму строку — включая строку ответа собранного вопроса (фаза
      // 15, §4.1): поле уходит из вопроса и возвращается тем же жестом.
      e.preventDefault()
      onMove(arrowDir(e))
    } else if (chords.arrowUp(e)) {
      e.preventDefault()
      onArrow(block.id, 'up')
    } else if (chords.arrowDown(e)) {
      e.preventDefault()
      onArrow(block.id, 'down')
    } else if (chords.enter(e)) {
      e.preventDefault()
      onAddBelow(block.id)
    } else if (e.key === '/') {
      e.preventDefault()
      onAddBelow(block.id, { openMenu: true })
    } else if (chords.backspace(e)) {
      e.preventDefault()
      onBackspaceDelete(block.id)
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      onAddBelow(block.id, { seed: e.key })
    }
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    const text = e.clipboardData.getData('text')
    if (!text) return
    e.preventDefault()
    onAddBelow(block.id, { seed: text })
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      // Подсказки объявляем только когда фокус на самой остановке: во внутреннем
      // контроле (селектор шкалы, кнопки картинки) клавиши остановки не работают — та
      // же граница, что у onKeyDown выше. onFocus/onBlur всплывают, поэтому проверка нужна.
      onFocus={(e) => e.target === e.currentTarget && rowFocus.onFocus()}
      onBlur={(e) => e.target === e.currentTarget && rowFocus.onBlur(e)}
      // Кольцо при фокусе (§2.1): объектная остановка «подсвечена», видно, что каретка
      // на ней. Программный фокус с клавиатуры даёт focus-visible; :focus — подстраховка.
      className="min-w-0 rounded-md outline-none ring-primary/40 focus:ring-2 focus-visible:ring-2"
    >
      {children}
    </div>
  )
}

// AnswerField — редактируемый плейсхолдер поля: автор вводит сюда текст, который увидит
// респондент в пустом поле (settings.placeholder). Поверхность 'placeholder' и только она —
// объектные остановки (картинка, дата, шкала) рисуют контрол своего типа (kinds/*).
function AnswerField({
  block,
  insideQuestion = false,
  onArrow,
  onBackspaceDelete,
  onDeleteBlock,
  onOpenActions,
  onRowShift,
  onMove,
}: {
  block: Block
  // Как у ObjectStop: не первая строка группы меняет подпись пункта Mod+Alt+→.
  insideQuestion?: boolean
  onArrow?: (id: string, dir: 'up' | 'down') => void
  // Backspace в ПУСТОМ плейсхолдере — удалить поле (см. проп BlockRow). Внутри
  // объектной остановки (date) поля рисуются без обработчиков — там свой Backspace.
  onBackspaceDelete?: (id: string) => void
  // Cmd+Shift+Backspace — явное удаление блока/группы (§3.4). Только у редактируемого
  // поля (placeholder-типы); превью date фокусируется как объект (у него свой чорд).
  onDeleteBlock?: (id: string) => void
  // Cmd+. — меню действий блока (§3.3).
  onOpenActions?: () => void
  // Mod+Alt+→/← — ряд (§5). У ГОЛОГО поля инпут плейсхолдера — единственная
  // поверхность вопроса, поэтому жест обязан работать и здесь. Внутри объектной
  // остановки (date) поля рисуются без обработчиков — там жест ведёт ObjectStop.
  onRowShift?: (dir: 'left' | 'right') => void
  // Alt+↑↓ — перенос САМОЙ строки (фаза 15, §4.1). Инпут плейсхолдера — поверхность
  // строки ответа, и до фазы жест здесь не обрабатывался вовсе: уносить поле из
  // вопроса было нечем, а голое поле двигали с его же единственной строки. Теперь
  // это законный жест на любой строке ответа, поэтому и здесь.
  onMove?: (dir: 'up' | 'down') => void
}) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const [focused, setFocused] = useState(false)
  // Контекст подсказок инпута плейсхолдера (§7). Клавиш у него почти нет — это
  // необязательный лист обхода, и чипы там показывают ровно одну строку.
  const rowFocus = useRowFocus(block.id, 'field', false, true, insideQuestion)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  // Фокус-цель текстового поля — инпут плейсхолдера (§2.1). Только у placeholder-
  // типов; date рисуется превью и фокусируется как объект (цель — у ObjectStop).
  useRegisterFocusTarget(
    block.id,
    (edge) => {
      const el = inputRef.current
      if (el) textCaret(el).focus(edge)
    },
    supportsPlaceholder(block.type),
  )
  const ph = block.settings?.placeholder ?? ''
  const setPh = (value: string) =>
    updateBlock(block.id, { settings: { ...block.settings, placeholder: value } })
  // Подсказку-хинт показываем только при фокусе (клике) на поле.
  const hint = focused ? 'Плейсхолдер ответа (необязательно)' : undefined

  // ↑ с начала / ↓ с конца поля — уход на соседнюю строку (§2.1). Backspace в пустом
  // плейсхолдере УДАЛЯЕТ поле и уводит каретку на предыдущую остановку — единое
  // поведение всех поверхностей ответа (решение владельца 2026-07-26, отменяет
  // «поле — необязательный лист, Backspace его только пропускает» от 2026-07-24):
  // объект сносится Backspace'ом, последний вариант choice уносит свой блок, и
  // плейсхолдер не имеет права быть исключением. Осиротевшая подпись — законное
  // состояние: в неё подсаживают новый блок ответа. Left/Right и вертикаль внутри
  // длинного текста остаются нативными (caret-проверка на краю).
  function onFieldKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const c = textCaret(e.currentTarget)
    if (onOpenActions && chords.actionMenu(e)) {
      e.preventDefault()
      onOpenActions()
    } else if (onDeleteBlock && chords.deleteBlock(e)) {
      e.preventDefault()
      onDeleteBlock(block.id)
    } else if (onRowShift && (chords.rowRight(e) || chords.rowLeft(e))) {
      e.preventDefault()
      onRowShift(chords.rowRight(e) ? 'right' : 'left')
    } else if (onMove && chords.moveItem(e) && !chords.moveGroup(e)) {
      // Проверяется ДО стрелок обхода: Alt+↑↓ — это тоже стрелка, и обход перехватил
      // бы жест на краях текста. moveGroup исключён явно (в остальных поверхностях
      // его отсекает порядок веток): Alt+Shift+↑↓ здесь не обрабатывается, и молча
      // трактовать его как перенос строки значило бы соврать — карта такого не обещает.
      e.preventDefault()
      onMove(arrowDir(e))
    } else if (onArrow && chords.arrowUp(e) && c.caretAtStart()) {
      e.preventDefault()
      onArrow(block.id, 'up')
    } else if (onArrow && chords.arrowDown(e) && c.caretAtEnd()) {
      e.preventDefault()
      onArrow(block.id, 'down')
    } else if (onBackspaceDelete && chords.backspace(e) && e.currentTarget.value === '') {
      e.preventDefault()
      onBackspaceDelete(block.id)
    }
  }
  // Плейсхолдер правится многострочно только у длинного ответа — факт его типа. От него
  // же зависит положение глифа (к верхней строке, а не по центру высоты).
  const fieldRow = rowFacts(block.type)
  const multiline = fieldRow?.surface === 'placeholder' && !!fieldRow.multiline

  // Обёртка — только якорь глифа; ширину берёт из .rf-field-wrap (index.css),
  // где стоит тот же потолок --rf-input-max, что у поля. Просвет подпись→поле (14px)
  // даёт групповой контейнер (gap-3.5 у GroupRow) — свой mt тут не нужен (был бы
  // двойным отступом и ломал ритм 13.3).
  const wrap = (control: ReactNode, wide = false) => (
    <FieldWrap block={block} wide={wide} glyphTop={multiline}>
      {control}
    </FieldWrap>
  )
  const focusProps = {
    onFocus: () => {
      setFocused(true)
      rowFocus.onFocus()
    },
    onBlur: (e: FocusEvent<Element>) => {
      setFocused(false)
      rowFocus.onBlur(e)
    },
  }
  if (multiline) {
    return wrap(
      <textarea
        ref={(el) => {
          inputRef.current = el
        }}
        value={ph}
        onChange={(e) => setPh(e.target.value)}
        onKeyDown={onFieldKeyDown}
        rows={2}
        placeholder={hint}
        // block: убрать базлайн-просвет inline-block textarea (см. подпись выше) —
        // иначе под длинным полем копится ~7px и ритм 13.3 расходится.
        className={`block ${FIELD_CLS}`}
        {...focusProps}
      />,
      true,
    )
  }
  return wrap(
    <input
      ref={(el) => {
        inputRef.current = el
      }}
      value={ph}
      onChange={(e) => setPh(e.target.value)}
      onKeyDown={onFieldKeyDown}
      placeholder={hint}
      className={FIELD_CLS}
      {...focusProps}
    />,
  )
}

// OptionsInline — варианты choice-блока строками прямо под вопросом, с глифом
// радио/чекбокса как у готового поля. Клавиатура (§3.2): Enter — новый вариант
// СРАЗУ ПОСЛЕ текущего (Д5, фокус на него); Enter в пустом последнем — выход из
// списка (удалить его, новая строка после группы); Cmd/Ctrl+Enter — тоже вариант
// после текущего; Alt+↑/↓ — перенос варианта; Backspace в пустом — удалить и уйти
// на предыдущий (пустой первый → onLeaveTop, к подписи группы); ↑/↓ — обход
// вариантов, на краях — соседняя строка.
// Свободные ячейки рядов вариантов — отдельное пространство id, чтобы они не путались
// с id самих вариантов (те — sortable-элементы того же контекста).
const OPT_CELL = 'optcell:'
const optCellId = (optionId: string) => `${OPT_CELL}${optionId}`
const optCellOption = (id: string | number): string | null => {
  const s = String(id)
  return s.startsWith(OPT_CELL) ? s.slice(OPT_CELL.length) : null
}

function OptionsInline({
  block,
  mirrored,
  onLeaveTop,
  onArrow,
  onAddBelow,
  onDeleteBlock,
  onBackspaceDelete,
  onOpenActions,
  onRowShift,
}: {
  block: Block
  // Вся группа стоит в правой колонке ряда вопросов — кластеры значков уезжают
  // вправо, включая значки вариантов (см. OptionCard).
  mirrored: boolean
  onLeaveTop: () => void
  onArrow: (id: string, dir: 'up' | 'down') => void
  // Выход из списка (Enter в пустом последнем варианте): новая текстовая строка
  // после всей группы choice-блока.
  onAddBelow: (id: string, opts?: { openMenu?: boolean; seed?: string; inside?: boolean }) => void
  // Cmd+Shift+Backspace на варианте — явное удаление всего choice-блока (§3.4).
  onDeleteBlock: (id: string) => void
  // Backspace в пустом «призраке», когда вариантов нет: блок уходит, каретка — на
  // предыдущую остановку. Тот же обработчик, что у объектов и пустого плейсхолдера.
  onBackspaceDelete: (id: string) => void
  // Cmd+. на варианте — меню действий всего choice-блока (§3.3).
  onOpenActions: () => void
  // Mod+Alt+→/← у dropdown: список живёт в нативном select, рядов у его вариантов НЕТ
  // (спека §5.1), поэтому жест на этой поверхности переносит сам ВОПРОС. У голого
  // dropdown-поля список — единственная поверхность, иначе ряд ему был бы недоступен
  // с клавиатуры вовсе.
  onRowShift: (dir: 'left' | 'right') => void
}) {
  const addOption = useBuilderStore((s) => s.addOption)
  const addOptionAfter = useBuilderStore((s) => s.addOptionAfter)
  const moveOption = useBuilderStore((s) => s.moveOption)
  const placeOptionInRow = useBuilderStore((s) => s.placeOptionInRow)
  const takeOptionOwnRow = useBuilderStore((s) => s.takeOptionOwnRow)
  const reorderOptions = useBuilderStore((s) => s.reorderOptions)
  const removeOption = useBuilderStore((s) => s.removeOption)
  const removeBlock = useBuilderStore((s) => s.removeBlock)
  const options = useMemo(() => block.settings?.options ?? [], [block.settings?.options])
  // Умеет ли ЭТОТ список ряды вариантов — факт типа (kinds/<type>.tsx, row.optionRows).
  const choiceRow = rowFacts(block.type)
  const optionRows = choiceRow?.surface === 'choice' && choiceRow.optionRows
  // Контекст подсказок варианта (§7): Enter рождает вариант, а не блок, Alt+↑↓ двигает
  // вариант — поэтому у списка свои чипы, а не текстовые.
  const rowFocus = useRowFocus(block.id, 'option')
  // У призрака свой контекст подсказок: клавиши варианта на нём не работают (двигать
  // и удалять нечего), а обещать неработающее нельзя (§7).
  const ghostFocus = useRowFocus(block.id, 'newOption')
  const optionRefs = useRef(new Map<string, HTMLInputElement | null>())
  const ghostRef = useRef<HTMLInputElement>(null)
  // Id варианта, который тащат (null — драга нет): от него зависит, светить ли
  // свободные ячейки рядов.
  const [optDrag, setOptDrag] = useState<string | null>(null)
  const optionIds = useMemo(() => options.map((o) => o.id), [options])
  // Тот же порог активации, что у полотна: клик по ручке не должен начинать драг.
  // Клавиатурного сенсора здесь нет намеренно — у вариантов своя карта (Alt+↑↓,
  // Mod+Alt+←/→), и второй клавиатурный путь через ручку дублировал бы её.
  const optSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  // Свободная ячейка спрашивается указателем и ПЕРВОЙ — как зона жеста у вопросов:
  // цель намеренная, в общий конкурс центров её пускать незачем.
  const optCollision: CollisionDetection = (args) => {
    const cells = args.droppableContainers.filter((c) => optCellOption(c.id) !== null)
    if (cells.length > 0) {
      const hit = pointerWithin({ ...args, droppableContainers: cells })
      if (hit.length > 0) return hit
    }
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => optCellOption(c.id) === null),
    })
  }
  // Запрос фокуса держим в ref, а не в state: после add/remove опций стор меняет
  // массив → эффект переставляет фокус, не вызывая лишний ре-рендер (setState в
  // эффекте под запретом линта). 'last' — на последнюю опцию (после Enter/добавления).
  const pendingFocus = useRef<string | 'last' | null>(null)

  // Фокус-цель choice-строки (§2.1) — инпут варианта: край start → первый, end →
  // последний. Вариантов нет вовсе (только что созданный блок) → «призрак»: набор
  // начинается прямо с него, и каретка не пропадает.
  useRegisterFocusTarget(block.id, (edge) => {
    if (options.length === 0) {
      ghostRef.current?.focus()
      return
    }
    const target = edge === 'start' ? options[0] : options[options.length - 1]
    const el = target && optionRefs.current.get(target.id)
    if (el) textCaret(el).focus(edge)
  })

  useEffect(() => {
    const req = pendingFocus.current
    if (req === null) return
    const id = req === 'last' ? options[options.length - 1]?.id : req
    if (id) optionRefs.current.get(id)?.focus()
    pendingFocus.current = null
  }, [options])

  // Удаление варианта с исходом каретки по контракту (§12): предыдущий вариант, а его
  // нет — подпись группы. Единый путь для Backspace в пустом и для мусорки: удаление
  // мышью тоже не имеет права уронить каретку в body, а последний вариант вдобавок
  // уносит с собой сам блок (removeOption), и тогда уводить каретку надо ДО удаления —
  // после него строки, от которой считается «наверх», уже нет.
  function removeOptionAt(optionId: string, i: number) {
    const prev = options[i - 1]
    if (!prev) onLeaveTop()
    removeOption(block.id, optionId)
    if (prev) pendingFocus.current = prev.id
  }

  // Клавиши «призрака» (§3.2). Своих действий у него почти нет — он и есть одно
  // действие «набери текст»; остальное сводится к соседям и к судьбе блока.
  function onGhostKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const last = options[options.length - 1]
    if (chords.actionMenu(e)) {
      e.preventDefault()
      onOpenActions()
    } else if (chords.deleteBlock(e)) {
      e.preventDefault()
      onDeleteBlock(block.id)
    } else if (chords.enter(e)) {
      // Выход из списка — как раньше Enter в пустом последнем варианте: новая строка
      // после группы. Вариантов так и не появилось — блок уходит вместе с призраком
      // (каретку уже забрала новая строка, поэтому уводить её отсюда не нужно).
      e.preventDefault()
      onAddBelow(block.id)
      if (options.length === 0) removeBlock(block.id)
    } else if (chords.backspace(e)) {
      // Стирать в призраке нечего: либо возвращаемся к последнему варианту, либо —
      // если их нет — уходит сам блок, как на любой пустой поверхности ответа.
      e.preventDefault()
      if (last) optionRefs.current.get(last.id)?.focus()
      else onBackspaceDelete(block.id)
    } else if (chords.arrowUp(e)) {
      e.preventDefault()
      if (last) optionRefs.current.get(last.id)?.focus()
      else onLeaveTop()
    } else if (chords.arrowDown(e)) {
      e.preventDefault()
      onArrow(block.id, 'down')
    }
  }

  // Биндинги по e.code (§3.1). i — индекс варианта в options.
  function onOptionKeyDown(e: KeyboardEvent<HTMLInputElement>, optionId: string, i: number) {
    const empty = e.currentTarget.value === ''
    const isLast = i === options.length - 1
    if (chords.actionMenu(e)) {
      e.preventDefault()
      onOpenActions()
    } else if (chords.deleteBlock(e)) {
      // Явное удаление всего choice-блока (не варианта) — вариант удаляет Backspace.
      e.preventDefault()
      onDeleteBlock(block.id)
    } else if (chords.enter(e) && !e.metaKey && !e.ctrlKey && isLast && empty) {
      // Выход из списка: пустой последний вариант удаляем, новая текстовая строка
      // ложится после всей группы (как «Enter в конце списка» в текстовых редакторах).
      // Строку заводим ДО удаления: последний вариант уносит с собой сам блок, и
      // позицию «после группы» родителю было бы уже не от чего считать — новая
      // строка улетела бы в конец полотна.
      e.preventDefault()
      onAddBelow(block.id)
      removeOption(block.id, optionId)
    } else if (chords.enter(e)) {
      // Новый вариант сразу ПОСЛЕ текущего (Д5), фокус на него. Cmd/Ctrl+Enter —
      // тот же жест «действие над ответом» (§3.2).
      e.preventDefault()
      pendingFocus.current = addOptionAfter(block.id, optionId)
    } else if (chords.rowRight(e) || chords.rowLeft(e)) {
      // Mod+Alt+→/← — ряд вариантов (§5.1): та же механика и те же аккорды, что у
      // вопросов. Каретка едет с вариантом (фокус на тот же optionId — id стабилен).
      // У dropdown рядов нет, и жест уходит вопросу (см. проп onRowShift).
      e.preventDefault()
      // Ряды вариантов есть не у всякого списка (row.optionRows): у dropdown их нет —
      // список живёт в нативном select, и жест уходит ВОПРОСУ.
      if (!optionRows) return onRowShift(chords.rowRight(e) ? 'right' : 'left')
      const prev = options[i - 1]
      if (chords.rowLeft(e)) takeOptionOwnRow(block.id, optionId)
      else if (prev) placeOptionInRow(block.id, optionId, prev.id)
      pendingFocus.current = optionId
    } else if (chords.moveItem(e)) {
      // Alt+↑/↓ — перенос варианта; каретка едет с ним (фокус на тот же optionId).
      e.preventDefault()
      const dir = arrowDir(e)
      const target = dir === 'up' ? i - 1 : i + 1
      if (target >= 0 && target < options.length) {
        moveOption(block.id, optionId, dir)
        pendingFocus.current = optionId
      }
    } else if (chords.backspace(e) && empty) {
      e.preventDefault()
      removeOptionAt(optionId, i)
    } else if (chords.arrowDown(e)) {
      // Единый обход (§2.1): следующий вариант, а за последним — соседняя строка.
      e.preventDefault()
      const next = options[i + 1]
      if (next) optionRefs.current.get(next.id)?.focus()
      else onArrow(block.id, 'down')
    } else if (chords.arrowUp(e)) {
      e.preventDefault()
      const prev = options[i - 1]
      if (prev) optionRefs.current.get(prev.id)?.focus()
      else onLeaveTop()
    }
  }

  // Дроп варианта (§5.1): на другой вариант — перестановка, в свободную ячейку ряда —
  // бит column. Фокус не трогаем ни в одном исходе — «dnd мышью фокус не трогает» (§2.4).
  function onOptionDragEnd(e: DragEndEvent) {
    setOptDrag(null)
    const active = String(e.active.id)
    const over = e.over ? String(e.over.id) : null
    if (over === null) return
    const cell = optCellOption(over)
    if (cell !== null) {
      if (cell !== active) placeOptionInRow(block.id, active, cell)
      return
    }
    if (over !== active) reorderOptions(block.id, active, over)
  }

  const rows = packOptionRows(options)
  const index = new Map(options.map((o, i) => [o.id, i]))

  return (
    // Просвет подпись→первый вариант (14px) даёт групповой контейнер, не свой mt
    // (ритм 13.3).
    //
    // Dnd вариантов — СВОЙ DndContext, изолированный от блочного и группового слоёв
    // полотна (§5.1, EDITOR §5): третий слой в общем фильтре коллизий стал бы
    // конкурентом строкам, а его сенсор активируется только своей ручкой, поэтому
    // вложенность контекстов драги не смешивает. Always-замер — свободная ячейка
    // появляется на dragStart и меняет геометрию ряда.
    <DndContext
      sensors={optSensors}
      collisionDetection={optCollision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={(e) => setOptDrag(String(e.active.id))}
      onDragCancel={() => setOptDrag(null)}
      onDragEnd={onOptionDragEnd}
    >
      <SortableContext items={optionIds} strategy={rectSortingStrategy}>
        {/* rf-options/rf-row — ТЕ ЖЕ классы, что у превью и рендерера (fields.css), а
            не их Tailwind-копия: оттуда приезжает и ритм списка (12px), и потолок
            карточки min(--rf-input-max, 100%). Копия давала бы ритм, но не потолок —
            длинный вариант в редакторе был бы шире, чем у респондента. */}
        <div className="rf-options">
          {rows.map((row) => {
            // .rf-cell — половина ряда (fields.css). Карточка внутри обнимает текст, но
            // правая начинается с середины: у респондента ровно так же. У ряда из одного
            // обёртка ни на что не влияет — правило CSS адресует только детей .rf-row.
            const cells = row.map((cell) => (
              <div key={cell[0]!.id} className="rf-cell">
                {cell.map((o) => (
                  <OptionCard
                    key={o.id}
                    block={block}
                    option={o}
                    // Номер (и буква) — по позиции в ПОЛНОМ списке: ряды порядок документа
                    // не меняют, и A/B/C обязаны остаться теми же, что до переноса.
                    index={index.get(o.id)!}
                    mirrored={mirrored}
                    inputRef={(el) => {
                      optionRefs.current.set(o.id, el)
                    }}
                    onKeyDown={(e) => onOptionKeyDown(e, o.id, index.get(o.id)!)}
                    onRemove={() => removeOptionAt(o.id, index.get(o.id)!)}
                    rowFocus={rowFocus}
                  />
                ))}
              </div>
            ))
            // Ряд из одного + идёт драг варианта → правая ячейка показывается как
            // цель дропа. Зона — вся ПОЛОВИНА ряда (не полоса у края, как у вопросов):
            // карточка варианта обнимает текст, поэтому «край ряда» у неё не там, где
            // читается граница, а ячейка занимает ровно то место, куда карточка встанет.
            const solo = row.length === 1 ? row[0]![0]! : null
            const showCell = solo !== null && optDrag !== null && optDrag !== solo.id
            return row.length > 1 || showCell ? (
              <div key={row[0]![0]!.id} className="rf-row items-start">
                {cells}
                {showCell && <FreeCell optionId={solo!.id} />}
              </div>
            ) : (
              cells[0]
            )
          })}
          {/* «Призрак» — пустая строка в конце списка вместо кнопки «Добавить вариант»
              (решение владельца 2026-07-26). Вариантом она не является и в схеме её
              нет: набранный в ней текст рождает НАСТОЯЩИЙ вариант, а призрак тут же
              появляется под ним. Так список набирается подряд, как текст, а пустые
              варианты перестают уезжать в опубликованную форму. */}
          <GhostOption
            ref={ghostRef}
            multiple={!isSingleChoiceType(block.type)}
            onType={(text) => {
              pendingFocus.current = addOption(block.id, text)
            }}
            onKeyDown={onGhostKeyDown}
            rowFocus={ghostFocus}
          />
        </div>
      </SortableContext>
    </DndContext>
  )
}

// Свободная правая ячейка ряда вариантов — цель жеста «встань рядом с этим вариантом»
// (§5.1). Занимает РОВНО половину ряда (.rf-cell), то есть то самое место, куда карточка
// и встанет после дропа: у вопросов приглашением служит полоса у края ряда, но карточка
// варианта обнимает текст, и «край ряда» у неё не там, где читается граница. Живёт только
// во время драга варианта, поэтому места в покое не занимает и схлопнуть клик по карточке
// не может (урок TD-22 — про контролы, появляющиеся по hover).
function FreeCell({ optionId }: { optionId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: optCellId(optionId) })
  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      className={`rf-cell min-h-9 rounded-md border border-dashed transition-colors ${
        isOver ? 'border-primary bg-primary/10' : 'border-muted-foreground/40'
      }`}
    />
  )
}

// GhostOption — пустая строка в конце списка вариантов: место, где список
// продолжается. Вариантом она НЕ является — в схеме её нет, значков у неё нет,
// перетащить и удалить нечего; поэтому и выглядит она неактивной (приглушена), пока
// в ней пусто. Первый же набранный символ рождает настоящий вариант с этим текстом,
// каретка переезжает в него, а призрак появляется строкой ниже — визуально текст
// остаётся на месте, а под ним открывается новая пустая строка.
//
// Почему не кнопка «Добавить вариант» (была здесь до 2026-07-26): кнопка — отдельный
// жест и отдельная остановка, из-за которой список набирался «текст → мышь/Tab →
// текст». Призрак делает список обычным текстом, который набирают подряд.
//
// value всегда пустой: набранное уезжает в стор в тот же тик, поэтому призрак сам
// текст никогда не хранит — иначе он был бы вариантом-невидимкой со своим состоянием.
function GhostOption({
  ref,
  multiple,
  onType,
  onKeyDown,
  rowFocus,
}: {
  ref: React.RefObject<HTMLInputElement | null>
  // Тип списка решает ширину невидимого слота под глифом (чекбокс шире буквы).
  multiple: boolean
  onType: (text: string) => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  rowFocus: ReturnType<typeof useRowFocus>
}) {
  const placeholder = 'Добавить ответ'
  return (
    // Приглушён сильнее обычного (решение владельца 2026-07-26): строка обязана
    // читаться как приглашение, а не как ещё один вариант, который автор забыл
    // заполнить. В фокусе гасит приглушение — в неё уже набирают.
    <div className="relative flex items-center opacity-45 transition-opacity focus-within:opacity-100">
      <span className={`rf-option${multiple ? ' rf-option--check' : ''}`}>
        {/* Слот под глиф будущего варианта — невидимый, но место занимает: без него
            текст призрака стоял бы левее списка и прыгал бы вправо на первом же
            набранном символе. Ширину даёт тот же класс, что у настоящего варианта. */}
        <span
          aria-hidden="true"
          className={`${multiple ? 'rf-mark rf-mark--check' : 'rf-option-key'} opacity-0`}
        />
        <span className="rf-option-edit" data-value={placeholder}>
          <input
            ref={ref}
            value=""
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={onKeyDown}
            {...rowFocus}
            className="bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </span>
      </span>
    </div>
  )
}

// OptionCard — карточка варианта на полотне: sortable-элемент своего изолированного
// контекста. Значки — тот же кластер, что у строк полотна (удалить + перетащить),
// только адресованы варианту: строка ответа своих значков лишилась, потому что ею
// управляет подпись, а вариантами управлять по отдельности как раз нужно.
// Кластер absolute и вне потока: контрол, занимающий место и появляющийся по hover,
// схлопывается на mousedown и съедает клик (TD-22).
function OptionCard({
  block,
  option,
  index,
  mirrored,
  inputRef,
  onKeyDown,
  onRemove,
  rowFocus,
}: {
  block: Block
  option: NonNullable<NonNullable<Block['settings']>['options']>[number]
  index: number
  // mirrored — вся группа стоит в правой колонке ряда ВОПРОСОВ (см. BlockRow): слева
  // от неё чужой вопрос во всю ширину, поэтому кластер уезжает вправо вместе с
  // кластерами строк. Внутри списка вариантов сторона не меняется никогда — даже у
  // правого варианта ряда: карточка обнимает текст, и слева от неё есть место
  // (решение владельца 2026-07-26: варианты выглядят как блоки вопросов).
  mirrored: boolean
  inputRef: (el: HTMLInputElement | null) => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  // Удаление варианта с исходом каретки по контракту (§12) — считает список, он
  // один знает соседей. Мусорка и Backspace в пустом ведут в одну точку.
  onRemove: () => void
  rowFocus: ReturnType<typeof useRowFocus>
}) {
  const updateOption = useBuilderStore((s) => s.updateOption)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: option.id,
    animateLayoutChanges: noLayoutAnimation,
  })
  const placeholder = `Вариант ${index + 1}`
  const key = optionKey(index)
  const multiple = !isSingleChoiceType(block.type)
  return (
    // group/opt — именованная группа СВОЕЙ карточки (TD-31): безымянный group занят
    // всей строкой блока, и от него крестики расцветали у всех вариантов разом при
    // наведении на любую точку строки.
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`group/opt relative flex items-center ${isDragging ? 'z-10 opacity-70' : ''}`}
    >
      {/* Кластер значков варианта — зеркало кластера строки: те же размеры, тот же
          порядок (удалить, перетащить — ручка ближе к тексту), то же проявление по
          hover своей карточки (group/opt: безымянный group занят строкой блока, и от
          него значки расцветали у всех вариантов разом — TD-31).
          Отступ тоже тот же (mr-2.5, не mr-1.5): в жёлобе между кластером и текстом
          лежит рейл группы (-left-2, GroupRow), и с меньшим отступом ручка ложится
          прямо на линию. Ручки вариантов и ручки строк выстраиваются в одну
          вертикаль — у обоих кластеров правый край на 10px левее колонки. */}
      <div
        className={`absolute flex ${
          mirrored ? 'left-full ml-2.5 flex-row-reverse' : 'right-full mr-2.5'
        } items-center gap-0.5 opacity-0 transition-opacity group-hover/opt:opacity-100`}
      >
        <button
          type="button"
          tabIndex={-1}
          onClick={onRemove}
          aria-label="Удалить вариант"
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Переместить вариант"
          className="flex size-5 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
          {...attributes}
          {...listeners}
          // Значки — не остановки обхода: каретка ходит по вариантам, а не по их
          // кнопкам. Ставим ПОСЛЕ спреда: attributes несут свой tabIndex, и порядок
          // здесь решает, чей победит.
          tabIndex={-1}
        >
          <GripVertical className="size-4" />
        </button>
      </div>
      <span className={`rf-option${multiple ? ' rf-option--check' : ''}`}>
        {/* Что стоит перед текстом, решает тип — ровно как у респондента
            (BlockField): «несколько из списка» — обычный чекбокс без карточки,
            «один из списка» — карточка с буквенным бейджем. Здесь оба элемента
            декоративны (span, aria-hidden): автор правит текст, а не отвечает. */}
        {multiple ? (
          <span className="rf-mark rf-mark--check" aria-hidden="true" />
        ) : (
          key && (
            <span className="rf-option-key" aria-hidden="true">
              {key}
            </span>
          )
        )}
        {/* data-value — копия текста, задающая ширину (см. .rf-option-edit
            в index.css). Пустой вариант меряется по плейсхолдеру, иначе
            карточка схлопнулась бы в точку. */}
        <span className="rf-option-edit" data-value={option.label || placeholder}>
          <input
            ref={inputRef}
            value={option.label}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => updateOption(block.id, option.id, e.target.value)}
            onKeyDown={onKeyDown}
            {...rowFocus}
            className="bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </span>
      </span>
    </div>
  )
}
