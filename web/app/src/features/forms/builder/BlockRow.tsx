import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
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
import { Asterisk, GripVertical, Plus, Trash2, X } from 'lucide-react'
import {
  type Block,
  carriesText,
  isCaptionType,
  isChoiceType,
  isContentType,
  SCALE_LOWER_BOUND,
  SCALE_UPPER_BOUND,
  scaleRange,
  supportsPlaceholder,
} from '@entities/formSchema'
import { BlockControl } from '@fields/BlockField'
import { optionKey } from '@fields/answer'
import { packOptionRows } from '@fields/groups'
import { filterMenuItems, type MenuItem } from './blockTypes'
import { noLayoutAnimation } from './dnd'
import { typeIcons } from './blockTypeIcons'
import { useBuilderStore } from './storeContext'
import { useFocusEngine, useRegisterFocusTarget } from './focusEngine'
import { textCaret } from './caret'
import { SlashMenu } from './SlashMenu'
import { BlockActionMenu } from './BlockActionMenu'
import { ImageField } from './ImageField'
import { arrowDir, chords } from './shortcuts'
import { useRowFocus } from './activeRow'
import { RowHints } from './RowHints'

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
  // Позиция строки на полотне — для плейсхолдеров пустой строки (§7, слой 1: «тип
  // блока × позиция»). insideQuestion — строка внутри вопроса, но не его подпись
  // (там пустой текст = описание вопроса); firstOfForm — самая первая строка полотна
  // (там пустой текст = начало формы, и подсказка зовёт добавить вопрос).
  insideQuestion?: boolean
  firstOfForm?: boolean
  // mirrored — строка стоит в ПРАВОЙ колонке half-ряда (спека §5): кластер значков
  // зеркалится в правое поле (левый лёг бы в 28px-жёлоб между колонками и наехал
  // на соседнюю группу), тогл обязательности остаётся у правого края текста.
  mirrored?: boolean
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
  // onDeleteObject — Backspace на объектной остановке (image/date/scale): удалить
  // объект и увести каретку на предыдущую строку/заголовок (§2.2, знает соседей).
  onDeleteObject: (id: string) => void
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
  insideQuestion = false,
  firstOfForm = false,
  mirrored = false,
  openMenuOnMount,
  onAddBelow,
  onInsertBelow,
  onBackspaceAtStart,
  onDeleteObject,
  onDeleteBlock,
  onAnswerAction,
  onArrow,
  onRowShift,
}: BlockRowProps) {
  const engine = useFocusEngine()
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const moveBlock = useBuilderStore((s) => s.moveBlock)
  const moveGroup = useBuilderStore((s) => s.moveGroup)
  const removeBlock = useBuilderStore((s) => s.removeBlock)
  const removeGroup = useBuilderStore((s) => s.removeGroup)
  const changeBlockType = useBuilderStore((s) => s.changeBlockType)
  const makeQuestion = useBuilderStore((s) => s.makeQuestion)
  const makeField = useBuilderStore((s) => s.makeField)
  const duplicateBlock = useBuilderStore((s) => s.duplicateBlock)
  const labelRef = useRef<HTMLTextAreaElement>(null)
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
  // Описание вопроса: раскрыто ли поле. Непустое описание раскрыто с монтирования.
  // Триггер раскрытия живёт в левом кластере значков (absolute) — см. коммент там.
  // Плейсхолдер заголовка виден только у активной (в фокусе) строки: неактивный
  // пустой блок ничего не показывает.
  const [labelFocused, setLabelFocused] = useState(false)
  // Подсказки (§7): текстовая поверхность объявляет свой контекст карты — от него
  // зависят чипы у каретки и шпаргалка Mod+/. Остальные поверхности строки (варианты,
  // инпут плейсхолдера, объектная остановка) объявляют свой контекст сами.
  const textFocus = useRowFocus(block.id, 'text', groupHasAnswer)
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
  const captionPh =
    block.type === 'title'
      ? 'Заголовок вопроса'
      : block.type === 'label'
        ? 'Подпись поля'
        : block.type === 'heading'
          ? 'Заголовок раздела'
          : block.type === 'consent'
            ? 'Текст согласия'
            : labelFocused
              ? textPh
              : undefined
  const isContent = isContentType(block.type)
  const isImage = block.type === 'image'
  // Согласие правится строкой заголовка (текст согласия = label), поэтому у него
  // нет отдельного превью-контрола: галочка стоит слева от самого текста.
  const isConsent = block.type === 'consent'
  // hasTextLine — у блока есть редактируемая строка текста: подписи/контент и
  // consent. Поля ввода строки не несут — их подпись живёт отдельным блоком.
  const hasTextLine = carriesText(block.type)
  const captionCls =
    block.type === 'title'
      ? 'rf-label placeholder:font-semibold'
      : block.type === 'label'
        ? 'rf-label rf-label--sm placeholder:font-medium'
        : block.type === 'heading'
          ? 'rf-heading placeholder:font-semibold'
          : block.type === 'consent'
            ? 'rf-consent placeholder:font-normal'
            : 'rf-text placeholder:font-normal'

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
    return el ? textCaret(el) : null
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
  function onLabelKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const c = textCaret(e.currentTarget)
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
      moveBlock(block.id, arrowDir(e))
    } else if (chords.arrowUp(e) && c.caretAtStart()) {
      e.preventDefault()
      onArrow(block.id, 'up')
    } else if (chords.arrowDown(e) && c.caretAtEnd()) {
      e.preventDefault()
      onArrow(block.id, 'down')
    }
  }

  // Раскрыть поле описания и поставить в него каретку (rAF — textarea появляется
  // только на следующий рендер). Уже раскрытое просто фокусируем.

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
  function pickSlash(item: MenuItem) {
    if (slash) {
      const value = block.text ?? ''
      const end = slash.start + 1 + slash.query.length
      updateBlock(block.id, { text: value.slice(0, slash.start) + value.slice(end) })
    }
    pickType(item)
  }

  // onChange текстовой строки: ведёт инлайн-слеш (§3.5). Открытое меню — пересчитываем
  // фильтр от каретки; каретка ушла за «/», там пробел/перенос, или ни один тип не
  // совпал — закрываем, текст (включая «/») остаётся. Меню закрыто — «/» прямо перед
  // кареткой у неотвечаемого (text) блока открывает его. Печать всегда идёт в текст.
  function onLabelChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value
    const caret = e.target.selectionStart ?? value.length
    updateBlock(block.id, { text: value })
    if (slash) {
      if (caret <= slash.start || value[slash.start] !== '/') return closeSlash()
      const query = value.slice(slash.start + 1, caret)
      if (/\s/.test(query) || filterMenuItems(query).length === 0) return closeSlash()
      setSlash({ start: slash.start, query })
      setSlashActive(0)
    } else if (isContent && caret > 0 && value[caret - 1] === '/') {
      setSlash({ start: caret - 1, query: '' })
      setSlashActive(0)
    }
  }

  const iconBtn =
    'flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground'

  // Высота кластеров значков = line-height ПЕРВОЙ строки блока (fields.css):
  // вопрос rf-label — 28px (h-7), абзац rf-text и согласие rf-consent — 24px (h-6).
  // Кластеры absolute и центрируют значок по своей высоте, поэтому только так они
  // стоят на уровне текста. Жёсткое значение тут — баг: при h-8 (32px) значки висят
  // ниже строки у всех типов сразу. Меняется вместе с line-height в fields.css.
  const rowLineH = block.type === 'title' || block.type === 'heading' ? 'h-7' : 'h-6'

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
      className={`group relative rounded-md -my-1.5 py-1.5 ${isDragging ? 'z-10 opacity-70' : ''}`}
    >
      {/* Меню действий блока (Cmd+. §3.3): якорь — нулевой span в левом absolute-поле
          строки, сам поповер порталится. onPickType — тот же pickType, что у слеш-меню
          (makeQuestion/makeField/changeBlockType + фокус на результат). */}
      <BlockActionMenu
        open={actionOpen}
        onOpenChange={setActionOpen}
        block={block}
        anchor={<span aria-hidden="true" className="pointer-events-none absolute left-0 top-1.5" />}
        onToggleRequired={() => updateBlock(block.id, { required: !block.required })}
        onDuplicate={() => duplicateBlock(block.id)}
        onDelete={() => onDeleteBlock(block.id)}
        onPickType={pickType}
      />

      {/* Все элементы управления — в левом поле (вне колонки текста, absolute), поэтому
          сам текст остаётся по центру колонки. Всегда видимы; высота кластера =
          line-height первой строки блока (rowLineH) + items-center → значки на
          уровне текста. Порядок: удалить, добавить,
          описание, перетащить (ручка последняя = ближайшая к тексту).

          Кластер absolute и проявляется через opacity — высоту строки он не меняет
          НИКОГДА, и это здесь не косметика, а требование корректности. Контрол,
          который появляется по hover/фокусу и при этом занимает место в потоке,
          схлопывается синхронно на mousedown (фокус уходит из блока → блок теряет
          :focus-within → высота падает): всё, что ниже, уезжает вверх, mouseup
          приходит уже мимо цели, и браузер диспатчит click на общего предка —
          обработчик кнопки не срабатывает. Именно так «+ Описание», стоявшее в
          потоке под заголовком, съедало первый клик по «+ Добавить блок» (TD-22).
          Любой новый reveal-on-hover контрол блока — только сюда. */}
      {/* tabIndex=-1 у значков строки: полотно — один Tab-stop, кнопки-значки —
          мышиные удобства и выпадают из Tab-обхода (§3.1). Клавиатурные эквиваленты —
          шорткаты (Alt+↑/↓ — перенос) и меню действий Cmd+. (13.2). */}
      <div
        // mr-2.5 (не mr-1): между кластером и текстом живёт рейл группы (-left-2,
        // GroupRow) — значки отодвинуты, чтобы грип не ложился на линию.
        // mirrored (правая колонка half-ряда): кластер уезжает в ПРАВОЕ поле, за
        // тогл обязательности (тот стоит на left-full ml-1, ширина 24px → ml-7).
        className={`absolute top-1.5 flex ${
          mirrored ? 'left-full ml-7 flex-row-reverse' : 'right-full mr-2.5'
        } ${rowLineH} items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100`}
      >
        <button
          type="button"
          tabIndex={-1}
          onClick={() => (isCaptionType(block.type) ? removeGroup(block.id) : removeBlock(block.id))}
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
        {/* Описание — только у отвечаемых блоков (неотвечаемый text рендерится
            статикой, описания не имеет), как и RequiredToggle справа. */}

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
          левому кластеру значков. Только у отвечаемых блоков: неотвечаемый text
          ответов не собирает, required к нему неприменим. */}
      {isContent ? null : <RequiredToggle block={block} lineH={rowLineH} />}

      {/* Чипы-подсказки сфокусированной строки (§7): только клавиши этой поверхности,
          общие — в шпаргалке Mod+/. Рисуются всегда, содержимое выбирает сам RowHints
          по активной строке (и ничего не рисует, когда каретка не здесь). */}
      <RowHints rowId={block.id} lineH={rowLineH} />

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
              <textarea
                ref={labelRef}
                rows={1}
                value={block.text ?? ''}
                placeholder={captionPh}
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
                // block: textarea по умолчанию inline-block и оставляет под собой
                // ~7px базлайн-просвета (line-box строки-подписи выше textarea) — он
                // раздувал ритм подпись→поле (13.3). display:block его убирает.
                className={`block w-full resize-none bg-transparent outline-none placeholder:text-muted-foreground/60 ${captionCls}`}
              />
            </div>
          </div>
        </SlashMenu>
      ) : isChoiceType(block.type) ? (
        <div className="min-w-0">
          <OptionsInline
            block={block}
            onLeaveTop={() => onArrow(block.id, 'up')}
            onArrow={onArrow}
            onAddBelow={onAddBelow}
            onDeleteBlock={onDeleteBlock}
            onOpenActions={() => setActionOpen(true)}
            onRowShift={(dir) => onRowShift(block.id, dir)}
          />
        </div>
      ) : supportsPlaceholder(block.type) ? (
        <div className="min-w-0">
          <AnswerField
            block={block}
            onArrow={onArrow}
            onDeleteBlock={onDeleteBlock}
            onOpenActions={() => setActionOpen(true)}
            onRowShift={(dir) => onRowShift(block.id, dir)}
          />
        </div>
      ) : (
        // image/date/scale — объектная остановка: фокусируемая строка с кольцом (§2.2).
        <ObjectStop
          block={block}
          onAddBelow={onAddBelow}
          onDeleteObject={onDeleteObject}
          onArrow={onArrow}
          onDeleteBlock={onDeleteBlock}
          onOpenActions={() => setActionOpen(true)}
          onMove={(dir) => moveBlock(block.id, dir)}
          onMoveGroup={(dir) => moveGroup(block.id, dir)}
          onRowShift={(dir) => onRowShift(block.id, dir)}
        >
          {isImage ? (
            <ImageField block={block} formId={formId} />
          ) : block.type === 'scale' ? (
            <ScaleInline block={block} />
          ) : (
            <AnswerField block={block} />
          )}
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
  children,
  onAddBelow,
  onDeleteObject,
  onDeleteBlock,
  onOpenActions,
  onArrow,
  onMove,
  onMoveGroup,
  onRowShift,
}: {
  block: Block
  children: ReactNode
  onAddBelow: (id: string, opts?: { openMenu?: boolean; seed?: string; inside?: boolean }) => void
  onDeleteObject: (id: string) => void
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
  const rowFocus = useRowFocus(block.id, block.type === 'image' ? 'image' : 'object')

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
      onDeleteObject(block.id)
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

// AnswerField — поле ответа под вопросом. Для текстовых типов оно редактируемое:
// автор вводит сюда текст-плейсхолдер (settings.placeholder), который увидит
// респондент. date — статичное превью (в поле даты плейсхолдер не показывается).
// ScaleInline — редактор шкалы: живое превью делений (тот же rf-scale, что увидит
// респондент) плюс выбор диапазона.
//
// Концы выбираются из <select>, а не вводятся числом, намеренно: ValidateSchema
// строго требует min < max в пределах [0,10], а свободный ввод даёт невалидные
// промежуточные состояния (пустое поле, min>max посреди набора) — автосейв ловил бы
// 422 на каждое нажатие. Список вариантов делает такое состояние невозможным.
function ScaleInline({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const { min, max } = scaleRange(block)

  const set = (next: { min?: number; max?: number }) => {
    const m = next.min ?? min
    const x = next.max ?? max
    updateBlock(block.id, {
      // Максимум не может опуститься до минимума: держим его хотя бы на шаг выше.
      settings: { ...block.settings, scaleMin: m, scaleMax: Math.max(x, m + 1) },
    })
  }

  const selectCls =
    'h-7 rounded border border-muted-foreground/30 bg-transparent px-1.5 text-sm text-foreground'

  return (
    <div className="flex flex-col gap-2">
      {/* Только контрол, без FieldShell: подпись рисует строка заголовка выше —
          оболочка дублировала бы её (вопрос стоял бы и над блоком, и над шкалой).
          Просвет подпись→шкала (14px) даёт групповой контейнер, не свой mt (ритм 13.3). */}
      <BlockControl block={block} />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <label className="flex items-center gap-1.5">
          от
          <select
            className={selectCls}
            value={min}
            onChange={(e) => set({ min: Number(e.target.value) })}
          >
            {[SCALE_LOWER_BOUND, SCALE_LOWER_BOUND + 1].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          до
          <select
            className={selectCls}
            value={max}
            onChange={(e) => set({ max: Number(e.target.value) })}
          >
            {Array.from({ length: SCALE_UPPER_BOUND - min }, (_, i) => min + 1 + i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

function AnswerField({
  block,
  onArrow,
  onDeleteBlock,
  onOpenActions,
  onRowShift,
}: {
  block: Block
  onArrow?: (id: string, dir: 'up' | 'down') => void
  // Cmd+Shift+Backspace — явное удаление блока/группы (§3.4). Только у редактируемого
  // поля (placeholder-типы); превью date фокусируется как объект (у него свой чорд).
  onDeleteBlock?: (id: string) => void
  // Cmd+. — меню действий блока (§3.3).
  onOpenActions?: () => void
  // Mod+Alt+→/← — ряд (§5). У ГОЛОГО поля инпут плейсхолдера — единственная
  // поверхность вопроса, поэтому жест обязан работать и здесь. Внутри объектной
  // остановки (date) поля рисуются без обработчиков — там жест ведёт ObjectStop.
  onRowShift?: (dir: 'left' | 'right') => void
}) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const [focused, setFocused] = useState(false)
  // Контекст подсказок инпута плейсхолдера (§7). Клавиш у него почти нет — это
  // необязательный лист обхода, и чипы там показывают ровно одну строку.
  const rowFocus = useRowFocus(block.id, 'field')
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

  // ↑ с начала / ↓ с конца поля — уход на соседнюю строку (§2.1). Backspace в начале
  // пустого — уход ВВЕРХ на предыдущую остановку (обычно подпись группы), НЕ удаление:
  // поле — необязательный лист, его сносит только явный Cmd+Shift+Backspace, иначе
  // подпись осталась бы сиротой (решение владельца 2026-07-24; navigation.ts). В само
  // поле каретка попадает лишь явно (Cmd+Enter/клик), поэтому это редкий путь. Left/
  // Right и вертикаль внутри длинного текста остаются нативными (caret-проверка на краю).
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
    } else if (onArrow && chords.arrowUp(e) && c.caretAtStart()) {
      e.preventDefault()
      onArrow(block.id, 'up')
    } else if (onArrow && chords.arrowDown(e) && c.caretAtEnd()) {
      e.preventDefault()
      onArrow(block.id, 'down')
    } else if (onArrow && chords.backspace(e) && e.currentTarget.value === '' && c.caretAtStart()) {
      e.preventDefault()
      onArrow(block.id, 'up')
    }
  }
  // Вид поля — общий rf-input (единый с превью/рендерером); rf-input-typed даёт
  // место под глиф типа справа (см. index.css).
  const cls = 'rf-input rf-input-typed'

  // Глиф типа поля в правом углу — подсказка автору, ЧТО это за поле, когда
  // подпись ещё не написана. Только в редакторе: у респондента тип виден по
  // самому контролу, и в публичной форме Tally такого глифа нет (проверено
  // замером). Берём typeIcons — тот же словарь, что в slash-меню и диалоге
  // добавления, чтобы тип выглядел одинаково везде, где о нём говорят.
  // pointer-events-none обязателен: иначе глиф съедает клик по правому краю поля.
  const typeGlyph = (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute right-2 text-muted-foreground/70 ${
        block.type === 'long_text' ? 'top-2' : 'top-1/2 -translate-y-1/2'
      }`}
    >
      {typeIcons[block.type]}
    </span>
  )
  // Обёртка — только якорь глифа; ширину берёт из .rf-field-wrap (index.css),
  // где стоит тот же потолок --rf-input-max, что у поля. Просвет подпись→поле (14px)
  // даёт групповой контейнер (gap-3.5 у GroupRow) — свой mt тут не нужен (был бы
  // двойным отступом и ломал ритм 13.3).
  const wrap = (control: ReactNode, wide = false) => (
    <div className={`rf-field-wrap ${wide ? 'rf-field-wrap--wide' : ''}`}>
      {control}
      {typeGlyph}
    </div>
  )

  if (!supportsPlaceholder(block.type)) {
    return wrap(<input type="date" disabled className={`${cls} pointer-events-none`} />)
  }
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
  if (block.type === 'long_text') {
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
        className={`block ${cls}`}
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
      className={cls}
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
  onLeaveTop,
  onArrow,
  onAddBelow,
  onDeleteBlock,
  onOpenActions,
  onRowShift,
}: {
  block: Block
  onLeaveTop: () => void
  onArrow: (id: string, dir: 'up' | 'down') => void
  // Выход из списка (Enter в пустом последнем варианте): новая текстовая строка
  // после всей группы choice-блока.
  onAddBelow: (id: string, opts?: { openMenu?: boolean; seed?: string; inside?: boolean }) => void
  // Cmd+Shift+Backspace на варианте — явное удаление всего choice-блока (§3.4).
  onDeleteBlock: (id: string) => void
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
  const options = useMemo(() => block.settings?.options ?? [], [block.settings?.options])
  // Контекст подсказок варианта (§7): Enter рождает вариант, а не блок, Alt+↑↓ двигает
  // вариант — поэтому у списка свои чипы, а не текстовые.
  const rowFocus = useRowFocus(block.id, 'option')
  const optionRefs = useRef(new Map<string, HTMLInputElement | null>())
  const addBtnRef = useRef<HTMLButtonElement>(null)
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
  // последний. Список пуст (недособранный черновик) → кнопка «добавить вариант»,
  // чтобы каретка не пропала (13.2 заведёт choice сразу с одним вариантом).
  useRegisterFocusTarget(block.id, (edge) => {
    if (options.length === 0) {
      addBtnRef.current?.focus()
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
      e.preventDefault()
      removeOption(block.id, optionId)
      onAddBelow(block.id)
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
      if (block.type === 'dropdown') return onRowShift(chords.rowRight(e) ? 'right' : 'left')
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
      const prev = options[i - 1]
      removeOption(block.id, optionId)
      if (prev) pendingFocus.current = prev.id
      else onLeaveTop()
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
            const cards = row.map((o) => (
              <OptionCard
                key={o.id}
                block={block}
                option={o}
                // Номер (и буква) — по позиции в ПОЛНОМ списке: ряды порядок документа
                // не меняют, и A/B/C обязаны остаться теми же, что до переноса.
                index={index.get(o.id)!}
                inputRef={(el) => {
                  optionRefs.current.set(o.id, el)
                }}
                onKeyDown={(e) => onOptionKeyDown(e, o.id, index.get(o.id)!)}
                rowFocus={rowFocus}
              />
            ))
            // Ряд из одного + идёт драг варианта → показываем свободную ячейку как
            // цель. У вопросов зона — правая треть ряда, но карточка варианта обнимает
            // текст и ряда не заполняет: ячейка честнее рисуется там, где она и есть —
            // справа от карточки.
            const showCell = row.length === 1 && optDrag !== null && optDrag !== row[0]!.id
            return row.length > 1 || showCell ? (
              <div key={row[0]!.id} className="rf-row items-start">
                {cards}
                {showCell && <FreeCell optionId={row[0]!.id} />}
              </div>
            ) : (
              cards[0]
            )
          })}
          <button
            ref={addBtnRef}
            type="button"
            tabIndex={-1}
            onClick={() => {
              pendingFocus.current = 'last'
              addOption(block.id)
            }}
            // Служебный ярус (14px), а не тело формы: это контрол редактора, которого
            // респондент не видит — как «+ Добавить блок» ниже по полотну. Был text-base
            // и читался как ещё один вариант ответа.
            className="flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-4" /> Добавить вариант
          </button>
        </div>
      </SortableContext>
    </DndContext>
  )
}

// Свободная правая ячейка ряда вариантов — цель жеста «встань рядом с этим вариантом»
// (§5.1). Живёт только во время драга варианта, поэтому места в покое не занимает и
// схлопнуть клик по карточке не может (урок TD-22 — про контролы, появляющиеся по
// hover). Пунктир показывает, куда именно ляжет карточка.
function FreeCell({ optionId }: { optionId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: optCellId(optionId) })
  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      className={`h-9 w-24 rounded-md border border-dashed transition-colors ${
        isOver ? 'border-primary bg-primary/10' : 'border-muted-foreground/40'
      }`}
    />
  )
}

// OptionCard — карточка варианта на полотне: sortable-элемент своего изолированного
// контекста. Ручка — вне потока (absolute): контрол, занимающий место и появляющийся
// по hover, схлопывается на mousedown и съедает клик (TD-22).
function OptionCard({
  block,
  option,
  index,
  inputRef,
  onKeyDown,
  rowFocus,
}: {
  block: Block
  option: NonNullable<NonNullable<Block['settings']>['options']>[number]
  index: number
  inputRef: (el: HTMLInputElement | null) => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  rowFocus: ReturnType<typeof useRowFocus>
}) {
  const updateOption = useBuilderStore((s) => s.updateOption)
  const removeOption = useBuilderStore((s) => s.removeOption)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: option.id,
    animateLayoutChanges: noLayoutAnimation,
  })
  const placeholder = `Вариант ${index + 1}`
  const key = optionKey(index)
  return (
    // group/opt — именованная группа СВОЕЙ карточки (TD-31): безымянный group занят
    // всей строкой блока, и от него крестики расцветали у всех вариантов разом при
    // наведении на любую точку строки.
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`group/opt relative flex items-center gap-1 ${isDragging ? 'z-10 opacity-70' : ''}`}
    >
      <button
        type="button"
        aria-label="Переместить вариант"
        className="absolute -left-5 cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover/opt:opacity-100"
        {...attributes}
        {...listeners}
        // Ручка — не остановка обхода: каретка ходит по вариантам, а не по их ручкам
        // (тот же tabIndex, что у крестика). Ставим ПОСЛЕ спреда: attributes несут
        // свой tabIndex, и порядок здесь решает, чей победит.
        tabIndex={-1}
      >
        <GripVertical className="size-3.5" />
      </button>
      <span className="rf-option">
        {/* Буква — та же декоративная подсказка, что видит респондент
            (rf-option-key). Глиф радио/чекбокса у карточки не рисуется ни
            тут, ни в форме: «один из» против «несколько из» показывает
            превью, где виден настоящий контрол. */}
        {key && (
          <span className="rf-option-key" aria-hidden="true">
            {key}
          </span>
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
      {/* Кнопка удаления — ВНЕ карточки и с постоянно занятым местом (меняется только
          opacity): контрол, появляющийся по hover в потоке, схлопывается на mousedown
          и съедает клик — TD-22, разбор у кластера значков выше. */}
      <button
        type="button"
        tabIndex={-1}
        onClick={() => removeOption(block.id, option.id)}
        aria-label="Удалить вариант"
        className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/opt:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
