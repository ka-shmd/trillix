import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  DndContext,
  KeyboardSensor,
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
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { toast } from 'sonner'
import {
  type Block,
  canShareRow,
  DEFAULT_SUBMIT_LABEL,
  isAnswerableType,
  isCaptionType,
  MAX_SUBMIT_LABEL_LEN,
} from '@entities/formSchema'
import { groupBlocks, groupCanShareRow, packRows } from '@fields/groups'
import { useBuilderStore } from './storeContext'
import { planBlockDrop, remapDropTarget, rowBoundaryTarget } from './store'
import { type MenuItem } from './blockTypes'
import { noLayoutAnimation } from './dnd'
import { BlockRow } from './BlockRow'
import { type FocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockTypeDialog } from './BlockTypeDialog'
import { chords, formatLabel, type ShortcutContext } from './shortcuts'
import { ShortcutSheet } from './ShortcutSheet'
import {
  ActiveRowApiProvider,
  ActiveRowValueProvider,
  CANVAS_ROW,
  TITLE_ROW,
  useActiveRowState,
  useRowFocus,
} from './activeRow'
import { stopNeighbor } from './navigation'
import { useRenameForm } from '../queries'
import { DEFAULT_FORM_TITLE } from '../../../entities/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// Дефолтный тип новой строки — «text» (неотвечаемый абзац). Пишешь текст, а «/»
// превращает строку в поле нужного типа — как в Notion/Tally.
const DEFAULT_BLOCK_TYPE = 'text' as const

// SlashEditor — полотно редактора: название формы первой строкой, ниже блоки как
// редактируемые строки. Фокусом между строками управляет фокус-движок (§2.5):
// строки регистрируют цели, обработчики зовут engine.focusBlock(id). menuForId
// просит свежесозданную строку открыть меню типов (вставка блока по «/»). Стор,
// автосейв и превью — прежние; переписана только поверхность ввода.
export function SlashEditor({
  formId,
  initialTitle,
  engine,
}: {
  formId: string
  initialTitle: string
  // Фокус-движок создаётся в BuilderScreen (переживает смену режима и нужен undo/redo,
  // §2.4) и раздаётся полотну через контекст.
  engine: FocusEngine
}) {
  const blocks = useBuilderStore((s) => s.blocks)
  const addBlockAfter = useBuilderStore((s) => s.addBlockAfter)
  const addBlockAfterGroup = useBuilderStore((s) => s.addBlockAfterGroup)
  const addQuestionAfter = useBuilderStore((s) => s.addQuestionAfter)
  const addFieldAfter = useBuilderStore((s) => s.addFieldAfter)
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const removeBlock = useBuilderStore((s) => s.removeBlock)
  const removeGroup = useBuilderStore((s) => s.removeGroup)
  const changeBlockType = useBuilderStore((s) => s.changeBlockType)
  const reorderBlocks = useBuilderStore((s) => s.reorderBlocks)
  const reorderGroups = useBuilderStore((s) => s.reorderGroups)
  const placeInRow = useBuilderStore((s) => s.placeInRow)
  const takeOwnRow = useBuilderStore((s) => s.takeOwnRow)
  // Драг-рамка (Д10): прямоугольник в координатах полотна (canvasRef), обнимающий
  // union-rect РЕАЛЬНЫХ (трансформированных) rect'ов строк будущего состава группы.
  // Статичный ring на <li> группы врал: sortable раздвигает строки CSS-трансформами,
  // а layout-бокс родителя не меняется — строки визуально уезжали за рамку. Поэтому
  // рамка — absolute-оверлей, который меряет DOM (getBoundingClientRect учитывает
  // трансформы) на каждый onDragMove/onDragOver. У группового драга отклик нативный
  // (sortable двигает группы сам), рамка не участвует.
  const canvasRef = useRef<HTMLDivElement>(null)
  const [frame, setFrame] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  // Сырая цель коллизии ДО подмены remapDropTarget. Рамка считает состав от неё:
  // e.over приходит уже ремапнутым (легальная точка), и planBlockDrop по нему
  // перенаправления не видит — рамка «обними чужую группу» иначе не зажглась бы
  // никогда, осталась бы одна щель.
  const rawOverRef = useRef<string | null>(null)
  // Во время драга рейлом групп управляет не hover (курсор с таскаемым элементом
  // мельтешит по hover-зонам — рейл мигал), а состояние: групповой драг зажигает
  // рейл у группы-цели постоянно, блочный — гасит рейлы совсем (иначе рейл
  // накладывался на драг-рамку).
  const [drag, setDrag] = useState<{
    kind: 'group' | 'block'
    activeId: string
    overGroup: string | null
  } | null>(null)
  // Замер рамки гонит rAF-цикл, а не события драга: строки доигрывают свой
  // CSS-переход (200мс) и после остановки курсора, onDragMove в это время молчит —
  // рамка отставала от расступающихся строк. Цикл меряет каждый кадр; аргументы
  // (активный блок и цель) обновляют обработчики. Пустой ref = цикл остановлен.
  const frameArgsRef = useRef<{ activeId: string; overId: string | null } | null>(null)
  const frameRafRef = useRef(0)
  const [menuForId, setMenuForId] = useState<string | null>(null)
  // Ссылка на textarea заголовка формы: когда удаляют последний блок и полотно пустеет,
  // фокус переносим сюда, а не теряем в body.
  const titleRef = useRef<HTMLTextAreaElement>(null)
  // Диалог выбора типа (кнопка «+»): открыт ли и после какого блока вставлять
  // (null — в конец).
  const [insertOpen, setInsertOpen] = useState(false)
  const [insertAfterId, setInsertAfterId] = useState<string | null>(null)
  // Активная строка полотна (§7) — источник контекста для чипов и шпаргалки.
  const activeRow = useActiveRowState()
  // Шпаргалка Mod+/ (§7, слой 3). Контекст — СНИМОК на момент вызова: открытие диалога
  // уводит фокус с полотна и гасит активную строку, а шпаргалка обязана показывать ту
  // строку, из которой её позвали.
  const [sheet, setSheet] = useState<{ open: boolean; ctx: ShortcutContext | null }>({
    open: false,
    ctx: null,
  })
  // Читать активную строку в оконном слушателе — только через ref: иначе подписка
  // пересоздаётся на каждое движение каретки.
  const activeCtxRef = useRef<ShortcutContext | null>(null)
  const sheetOpenRef = useRef(false)
  useEffect(() => {
    activeCtxRef.current = activeRow.active?.ctx ?? null
    sheetOpenRef.current = sheet.open
  })
  const openSheet = () => setSheet({ open: true, ctx: activeCtxRef.current })
  useEffect(() => {
    // globalThis.KeyboardEvent — нативное событие окна: имя KeyboardEvent в этом файле
    // занято React-синтетическим (импорт сверху).
    function onKey(e: globalThis.KeyboardEvent) {
      if (!chords.cheatSheet(e)) return
      // Mod+/ — тогл: повторное нажатие при открытой шпаргалке закрывает её, как Esc.
      e.preventDefault()
      if (sheetOpenRef.current) setSheet((s) => ({ ...s, open: false }))
      else setSheet({ open: true, ctx: activeCtxRef.current })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // dnd-kit: небольшой порог активации, чтобы клик по ручке не начинал перетаскивание;
  // клавиатурный сенсор — доступное перемещение стрелками при захвате ручки.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // Два уровня dnd. МУЛЬТИ-ГРУППА (подпись…поле) — единица перетаскивания за грип
  // подписи: внешний sortable по groupId (группа — один <li>, двигается нативно
  // целиком: родные сдвиги соседей, зазор высотой с группу, drop-анимация). Всё
  // остальное — БЛОЧНЫЙ слой: внутренние строки группы (контент/поле) и одиночки
  // (standalone-контент, голые поля, сироты-подписи) тащатся строкой и роняются в
  // ЛЮБУЮ позицию — внутрь группы, между группами, из группы наружу. Блочный слой —
  // ОДНА сортируемая вселенная: каждый GroupRow оборачивает свои строки в
  // SortableContext с ОБЩИМ списком всех block-id (blockIds), поэтому индексы
  // глобальны и анимация полностью родная — активная строка следует за курсором,
  // строки всех групп расступаются. Нарезка items по группам ломала драг: over в
  // чужом контексте → overIndex −1 → dnd-kit гасит все трансформы (элемент замирал
  // под мышкой). Слои НЕ конкурируют за коллизии: collisionDetection фильтрует
  // droppable'ы по слою активного элемента — тащат группу → только группы, тащат
  // блок → только строки. Без фильтра closestCenter метался между контейнером
  // группы и её строками (джиттер).
  // Разбиение — общий groupBlocks (@fields/groups), тот же, которым пакуют группы
  // превью и рендерер. Здесь стояла его побайтовая копия: единый раскладчик, ради
  // которого модуль и заведён, на одной из трёх поверхностей не использовался.
  const groups = useMemo(() => groupBlocks(blocks), [blocks])
  // groupIdList ОБЯЗАН быть стабильной ссылкой между ре-рендерами драга (как и
  // blockIds): items внешнего SortableContext сравниваются в useSortable по
  // ссылке (itemsHaveChanged), и свежий массив на рендере, где группа начинает
  // смещаться, отключает её transition — группа телепортируется вместо сдвига.
  // Ре-рендеры во время драга есть: setDrag (рейл цели) и setFrame (rAF рамки).
  const groupIdList = useMemo(() => groups.map((g) => g.id), [groups])
  const groupIds = useMemo(() => new Set(groupIdList), [groupIdList])
  const blockIds = useMemo(() => blocks.map((b) => b.id), [blocks])

  // Сторона группы в ряду (WYSIWYG, спека §5): раскладчик тот же, что у превью и
  // рендерера (packRows). Ряд двигает кластеры значков: у правой колонки они
  // зеркалятся вправо (левый кластер лёг бы в 28px-жёлоб и наехал на соседа).
  // Ряды видны ВСЕГДА, включая время драга: в столбике ряд распадается и появляется
  // цель «между левым и правым», которая после упаковки значит не то, что показала.
  // В двумерном полотне такой цели нет — вертикально вставляются между рядами
  // (границу держит rowBoundaryTarget).
  const rowSide = useMemo(() => {
    const m = new Map<string, 'left' | 'right'>()
    for (const row of packRows(groups)) {
      if (row.length === 2) {
        m.set(row[0]!.id, 'left')
        m.set(row[1]!.id, 'right')
      }
    }
    return m
  }, [groups])

  // Жест ряда (спека §5): пока тащат подходящий ВОПРОС, у каждого ряда со свободной
  // ячейкой горит правая треть. Кандидат — группа активного элемента: мульти-вопрос
  // едет за ручку подписи (групповой драг), голое поле — блочным слоем. Строку из
  // середины чужого вопроса жест не касается: она переносит блок, а не вопрос.
  const rowCandidate = useMemo(() => {
    if (!drag) return null
    if (drag.kind === 'group') {
      const g = groups.find((x) => x.id === drag.activeId)
      return g && groupCanShareRow(g.blocks) ? g.id : null
    }
    const b = blocks.find((x) => x.id === drag.activeId)
    if (!b || !isAnswerableType(b.type) || !canShareRow(b.type)) return null
    const g = groups.find((x) => x.id === b.groupId)
    return g && g.blocks.length === 1 ? g.id : null
  }, [drag, groups, blocks])

  const collisionDetection: CollisionDetection = (args) => {
    const isGroupDrag = groupIds.has(String(args.active.id))
    // Зоны жеста спрашиваются ПЕРВЫМИ и указателем, а не центрами: зона узкая и
    // намеренная, попадание в неё однозначно, а closestCenter тянул бы её в общий
    // конкурс со строками и мазал. Слоёв это не смешивает — зона отдельный вид
    // droppable'а и из обоих фильтров ниже исключена.
    const zones = args.droppableContainers.filter((c) => rowZoneGroup(c.id) !== null)
    if (zones.length > 0) {
      const hit = pointerWithin({ ...args, droppableContainers: zones })
      if (hit.length > 0) return hit
    }
    const collisions = closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (c) => rowZoneGroup(c.id) === null && groupIds.has(String(c.id)) === isGroupDrag,
      ),
    })
    if (isGroupDrag || collisions.length === 0) return collisions
    const activeId = String(args.active.id)
    const rawOver = String(collisions[0]!.id)
    rawOverRef.current = rawOver
    // Честная щель (§4.4): если ближайшая цель — строка внутри чужой мульти-группы,
    // куда отвечаемому/подписи нельзя, цель подменяется той строкой, дроп «на
    // которую» даёт легальную точку — sortable раскрывает щель там, где блок реально
    // приземлится (сразу под группой), а не раздвигает её строки изнутри. Дроп при
    // этом легален уже на уровне over; правило в planBlockDrop — вторая линия
    // обороны для путей мимо коллизий. Подмена — перестановкой внутри списка
    // closestCenter (там все кандидаты слоя): у dnd-kit over = collisions[0].
    let remapped = remapDropTarget(blocks, activeId, rawOver)
    // Ряд атомарен (§5) — и проверяется ПОСЛЕ §4.4: «под левым участником», которое
    // вернул remapDropTarget, и есть запретная щель между участниками ряда.
    const rowFixed = rowBoundaryTarget(blocks, activeId, remapped ?? rawOver)
    if (rowFixed) {
      remapped = rowFixed
      // Рамке тоже отдаём легальную цель: по сырой она обвела бы состав, который
      // после подмены не сложится (блок ляжет под ряд, а не в группу участника).
      rawOverRef.current = rowFixed
    }
    if (!remapped) return collisions
    const hit = collisions.find((c) => String(c.id) === remapped)
    return hit ? [hit, ...collisions.filter((c) => c !== hit)] : collisions
  }

  // Пересчёт драг-рамки: состав отдаёт planBlockDrop (будущая группа активного
  // блока, при перенаправлении — чужая группа, под которую он уедет), геометрию —
  // живой DOM по data-block-id. Пустой состав (блок остаётся одиночкой) — рамки нет.
  function updateFrame(activeId: string, overId: string | null) {
    const root = canvasRef.current
    if (!root || !overId || groupIds.has(activeId)) return setFrame(null)
    const plan = planBlockDrop(blocks, activeId, rawOverRef.current ?? overId)
    if (!plan || plan.frameIds.length === 0) return setFrame(null)
    const cr = root.getBoundingClientRect()
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const id of plan.frameIds) {
      const el = root.querySelector<HTMLElement>(`[data-block-id="${id}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      top = Math.min(top, r.top)
      bottom = Math.max(bottom, r.bottom)
      // Горизонталь — только от строк-резидентов: активная строка следует за
      // курсором по обеим осям, и её rect растягивал рамку вбок при горизонтальном
      // дрейфе, хотя горизонтального перемещения у полотна нет.
      if (id === activeId) continue
      left = Math.min(left, r.left)
      right = Math.max(right, r.right)
    }
    if (left === Infinity || top === Infinity) return setFrame(null)
    const next = { x: left - cr.left, y: top - cr.top, w: right - left, h: bottom - top }
    setFrame((p) =>
      p && p.x === next.x && p.y === next.y && p.w === next.w && p.h === next.h ? p : next,
    )
  }

  function startFrameLoop(activeId: string) {
    frameArgsRef.current = { activeId, overId: null }
    cancelAnimationFrame(frameRafRef.current)
    const tick = () => {
      const a = frameArgsRef.current
      if (!a) return
      updateFrame(a.activeId, a.overId)
      frameRafRef.current = requestAnimationFrame(tick)
    }
    frameRafRef.current = requestAnimationFrame(tick)
  }

  function stopFrameLoop() {
    frameArgsRef.current = null
    cancelAnimationFrame(frameRafRef.current)
    setFrame(null)
    rawOverRef.current = null
  }

  // Страховка на анмаунт посреди драга (смена маршрута): rAF-цикл не должен пережить
  // полотно.
  useEffect(() => () => cancelAnimationFrame(frameRafRef.current), [])

  // Дроп по слою: зона жеста → перенос в ряд, группа → перестановка групп, блок →
  // перестановка блоков.
  function onDragEnd(e: DragEndEvent) {
    stopFrameLoop()
    const candidate = rowCandidate
    setDrag(null)
    const { active, over } = e
    if (!over || active.id === over.id) return
    const zoneTarget = rowZoneGroup(over.id)
    if (zoneTarget !== null) {
      if (candidate) placeInRow(candidate, zoneTarget)
      return
    }
    const activeId = String(active.id)
    if (groupIds.has(activeId)) reorderGroups(activeId, String(over.id))
    else reorderBlocks(activeId, String(over.id))
  }

  // Создаёт новую текстовую строку и фокусирует её. Enter (§3.2) кладёт строку ПОСЛЕ
  // всей группы — новый блок не втискивается в текущий вопрос; Shift+Enter (opts.inside)
  // — сразу под текущей строкой, внутри группы (regroup оставит контент в вопросе).
  // Засев первого символа и открытие меню типов — опции с объектной остановки/пустого
  // полотна.
  function startBlock(
    afterId: string | null,
    opts: { openMenu?: boolean; seed?: string; inside?: boolean } = {},
  ) {
    const id = opts.inside
      ? addBlockAfter(afterId, DEFAULT_BLOCK_TYPE)
      : addBlockAfterGroup(afterId, DEFAULT_BLOCK_TYPE)
    // openMenu (вставка блока по «/» с объектной остановки/пустого полотна) засевает
    // строку литералом «/»: инлайн-слеш открыт с монтирования на позиции 0 (§3.5),
    // «/» остаётся в тексте, как при наборе «/» в самой строке.
    const seed = opts.openMenu ? '/' : opts.seed
    if (seed) updateBlock(id, { text: seed })
    if (opts.openMenu) setMenuForId(id)
    engine.focusBlock(id)
  }

  function focusFirstOrCreate() {
    const first = blocks[0]
    if (first) engine.focusBlock(first.id)
    else startBlock(null)
  }

  // Фокус на заголовок формы (его textarea всегда смонтирован над полотном): каретка
  // в конец. Сюда уходит фокус, когда удаляют первую/единственную строку — иначе он
  // потерялся бы в body. rAF не нужен (нет Radix-возврата фокуса).
  function focusTitle() {
    const el = titleRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }

  // onAddBelow: новая текстовая строка ниже — Enter (после группы), Shift+Enter
  // (opts.inside — внутрь группы), либо с засевом/меню с объектной остановки (§2.2).
  // Прокидывает opts в startBlock.
  function handleAddBelow(
    id: string,
    opts?: { openMenu?: boolean; seed?: string; inside?: boolean },
  ) {
    startBlock(id, opts)
  }

  // Кнопка «+»: открыть диалог выбора типа блока (после блока id).
  function handleInsertBelow(id: string) {
    setInsertAfterId(id)
    setInsertOpen(true)
  }

  // Выбор пункта в диалоге: «Вопросы» → подпись+поле новой группой; «Отдельные поля»
  // → голое поле новой группой; «Лэйаут» → один блок после текущего. Фокус — на
  // поверхность вставленного блока по возвращённому id (§2.4): подпись бандла, инпут
  // голого поля или объектная остановка (image/date/scale). Отдельной текстовой
  // строки под картинкой больше не заводим (§2.3, eager-text убран).
  function handlePickInsertType(item: MenuItem) {
    const id =
      item.group === 'question'
        ? addQuestionAfter(insertAfterId, item.type)
        : item.group === 'field'
          ? addFieldAfter(insertAfterId, item.type)
          : addBlockAfter(insertAfterId, item.type)
    engine.focusBlock(id)
    setInsertOpen(false)
  }

  // Backspace в начале блока — как в текстовом документе удаляет то, что перед
  // кареткой. Предыдущий блок — картинка → удаляем её, а текущий блок с кареткой
  // остаётся на месте (у image нет textarea, встать каретке некуда). Иначе — пустой
  // текущий блок схлопываем в предыдущий с переносом фокуса.
  function handleBackspaceAtStart(id: string) {
    const i = blocks.findIndex((b) => b.id === id)
    const cur = blocks[i]
    if (!cur) return
    const prev = blocks[i - 1]
    if (prev?.type === 'image') {
      // Картинка перед кареткой — удаляем её. Если текущий блок пуст, сбрасываем его к
      // обычному тексту: под удалённой картинкой должен остаться чистый текстовый блок,
      // а не пустое поле-вопрос. Непустой блок сохраняем как есть.
      removeBlock(prev.id)
      if ((cur.text ?? '') === '' && cur.type !== 'text') changeBlockType(cur.id, 'text')
      return
    }
    // Пустой блок схлопываем в предыдущий (фокус в его конец). Подпись владеет
    // группой (решение владельца): Backspace на пустой подписи сносит группу целиком
    // (подпись + контент + поле), а не оставляет осиротевшее голое поле. Предыдущего
    // блока нет — полотно пустеет, каретка на заголовок (не в body). Инпут плейсхолдера
    // перескакиваем (stopNeighbor): каретка встаёт на подпись, а не в поле.
    if ((cur.text ?? '') === '') {
      const prevStop = stopNeighbor(blocks, i, 'up')
      if (isCaptionType(cur.type)) removeGroup(id)
      else removeBlock(id)
      if (prevStop) engine.focusBlock(prevStop.id, 'end')
      else focusTitle()
    }
  }

  // Cmd/Ctrl+Enter (§3.2) — «действие над ответом»: из подписи/контента прыгнуть к
  // контролу ответа своей группы. choice: каретка на последний вариант (edge end), а
  // если вариантов ещё нет — на призрака списка, он же и есть место для набора.
  // На картинке файловый диалог открывает сама объектная остановка (см. ObjectStop).
  function handleAnswerAction(id: string) {
    const src = blocks.find((b) => b.id === id)
    if (!src) return
    const field = blocks.find((b) => b.groupId === src.groupId && isAnswerableType(b.type))
    if (!field) return
    engine.focusBlock(field.id, 'end')
  }

  // Cmd+Shift+Backspace (§3.4): явное удаление блока — на подписи сносит группу
  // целиком (подпись владеет группой), иначе один блок. Без диалога подтверждения
  // (решение владельца): страховка — тост с напоминанием про Ctrl+Z, а undo
  // восстанавливает группу в целости. Исход фокуса по контракту (§2.4): следующая
  // строка после группы, иначе предыдущая, иначе заголовок формы.
  function handleDeleteBlock(id: string) {
    const i = blocks.findIndex((b) => b.id === id)
    const cur = blocks[i]
    if (!cur) return
    const isGroup = isCaptionType(cur.type)
    // Удаляемый диапазон: подпись → вся смежная группа (regroup держит группу
    // односвязной), иначе только этот блок. Соседей берём ДО удаления по краям
    // диапазона — их id переживают операцию.
    const removed = isGroup ? blocks.filter((b) => b.groupId === cur.groupId) : [cur]
    const firstIdx = blocks.findIndex((b) => b.id === removed[0]!.id)
    // Исход фокуса перескакивает лист-поля (navigation.ts): от краёв удаляемого
    // диапазона ищем ближайшую остановку — следующую, иначе предыдущую.
    const next = stopNeighbor(blocks, firstIdx + removed.length - 1, 'down')
    const prev = stopNeighbor(blocks, firstIdx, 'up')
    if (isGroup) removeGroup(id)
    else removeBlock(id)
    if (next) engine.focusBlock(next.id, 'start')
    else if (prev) engine.focusBlock(prev.id, 'end')
    else focusTitle()
    toast(isGroup ? 'Вопрос удалён' : 'Блок удалён', { description: 'Ctrl+Z — вернуть' })
  }

  // Backspace на объектной остановке (§2.2/§2.4): удалить объект, каретка — в конец
  // предыдущей строки; её нет → заголовок формы.
  function handleBackspaceDelete(id: string) {
    const i = blocks.findIndex((b) => b.id === id)
    const prevStop = stopNeighbor(blocks, i, 'up')
    removeBlock(id)
    if (prevStop) engine.focusBlock(prevStop.id, 'end')
    else focusTitle()
  }

  // Обход стрелками между строками (§2.1): вниз — в начало следующей, вверх — в конец
  // предыдущей; из первой строки вверх — заголовок формы. Край определяет, куда встанет
  // каретка у многострочных/составных целей (первый/последний вариант choice).
  // Инпуты плейсхолдера с подписью — листы: поток их перескакивает (stopNeighbor),
  // каретка приземляется на подпись, а не в необязательное поле (navigation.ts).
  function handleArrow(id: string, dir: 'up' | 'down') {
    const i = blocks.findIndex((b) => b.id === id)
    const neighbor = stopNeighbor(blocks, i, dir)
    if (neighbor) engine.focusBlock(neighbor.id, dir === 'up' ? 'end' : 'start')
    else if (dir === 'up') focusTitle()
  }

  // Mod+Alt+→/← — клавиатурное зеркало жеста ряда (§5). Цель выбирает полотно: оно
  // знает соседей (как и у Backspace-схлопывания), строка знает только себя. Вправо —
  // в правую ячейку ПРЕДЫДУЩЕГО ряда, то есть в ряд с предыдущей группой; влево —
  // назад своим рядом. Каретка не трогается: id блока стабилен, строка не
  // перемонтируется — «каретка едет с блоком» (§2.4).
  function handleRowShift(id: string, dir: 'left' | 'right') {
    if (dir === 'left') return takeOwnRow(id)
    const gid = blocks.find((b) => b.id === id)?.groupId
    if (gid === undefined) return
    const gi = groups.findIndex((g) => g.id === gid)
    const prev = groups[gi - 1]
    if (prev) placeInRow(gid, prev.id)
  }

  return (
    // Метрики холста = общий .rf-page (fields.css): десктоп 96/80/96, мобильный
    // 40/20/64 — тот же брейкпоинт (sm=640), чтобы редактор не разъезжался с
    // превью/рендерером на узком экране.
    <FocusEngineProvider value={engine}>
    {/* Активная строка (§7): значение и API — разными провайдерами, чтобы строки-
        репортёры не перерисовывались от смены каретки (см. activeRow.ts). */}
    <ActiveRowApiProvider value={activeRow.api}>
    <ActiveRowValueProvider value={activeRow.active}>
    {/* relative — якорь координат драг-рамки (updateFrame меряет относительно него). */}
    <div ref={canvasRef} className="relative mx-auto max-w-[860px] px-5 pb-16 pt-10 sm:px-20 sm:pb-24 sm:pt-24">
      {/* Драг-рамка (Д10): один absolute-прямоугольник ДО списка в DOM — строки
          (positioned) рисуются поверх. Позиционирование ПРЯМОЕ, без собственной
          анимации: rAF-замер и так даёт гладкие значения (строки едут CSS-пере-
          ходами, union-rect движется вместе с ними), а своя пружина, ретаргети-
          руемая каждый кадр, копила скорость по движущейся цели — рамка отставала
          от расступающихся строк и отскакивала на их остановке. Скачок остаётся
          только при смене состава (переезд на другую группу) — осознанно: это
          резкая смена цели, а не движение. */}
      {frame && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 rounded-lg border-2 border-primary/40"
          style={{
            transform: `translate(${frame.x - 10}px, ${frame.y - 6}px)`,
            width: frame.w + 20,
            height: frame.h + 12,
          }}
        />
      )}
      <FormTitleInput
        formId={formId}
        initialTitle={initialTitle}
        onEnter={focusFirstOrCreate}
        titleRef={titleRef}
      />

      {blocks.length === 0 ? (
        <EmptyStarter onStart={(opts) => startBlock(null, opts)} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          // Always, а не дефолтный WhileDragging (меряет один раз на старте): ряды
          // живут весь драг, и блок, уходящий из ряда, меняет геометрию соседей по
          // ходу — по устаревшим rect'ам коллизии считались бы по прежней раскладке.
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={(e) => {
            const id = String(e.active.id)
            const isGroup = groupIds.has(id)
            setDrag({ kind: isGroup ? 'group' : 'block', activeId: id, overGroup: null })
            // Рамку ведёт rAF-цикл (см. frameArgsRef); групповой драг вместо
            // рамки ведёт рейл группы-цели (drag.overGroup).
            if (!isGroup) startFrameLoop(id)
          }}
          onDragOver={(e) => {
            const overId = e.over ? String(e.over.id) : null
            // Бэйл на тот же overGroup: лишний setState = лишний ре-рендер посреди
            // драга (см. коммент у groupIdList, чем это опасно).
            setDrag((d) =>
              d && d.kind === 'group' && d.overGroup !== overId ? { ...d, overGroup: overId } : d,
            )
            if (frameArgsRef.current) frameArgsRef.current.overId = overId
          }}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            stopFrameLoop()
            setDrag(null)
          }}
        >
          <SortableContext items={groupIdList} strategy={verticalListSortingStrategy}>
            {/* Ритм полотна = ритм превью/рендерера (этап 13.3), задаётся контейнерами:
                mt-12 (48px) заголовок формы→первый блок = gap у .rf-page; gap-7 (28px)
                МЕЖДУ группами = .rf-form. Внутри группы шаг 14px даёт GroupRow (gap-3.5).
                py-1.5 строк в вертикаль НЕ входит (там -my-1.5, см. BlockRow), поэтому
                flex-gap здесь = чистый просвет контента и совпадает с превью замером
                (критерий 13.3 — ноль расхождений). */}
            {/* flex-wrap (не flex-col): ряды складываются сами — две li по
                calc(50% - 14px) делят строку, одиночные (w-full) живут каждая на
                своей. gap-7 задаёт ОБА зазора: вертикальный ритм 28px (как прежний
                flex-col) и 28px между колонками ряда (= .rf-row превью).
                DOM-порядок = порядок документа, sortable-вселенная не тронута. */}
            <ol className="mt-12 flex flex-wrap gap-7">
              {groups.map((g, gi) => (
                <GroupRow
                  key={g.id}
                  group={g}
                  firstGroup={gi === 0}
                  formId={formId}
                  blockIds={blockIds}
                  side={rowSide.get(g.id) ?? null}
                  // Зона жеста — у ряда со СВОБОДНОЙ ячейкой (в ряду один участник,
                  // и он умеет делить ряд), и только пока тащат подходящий вопрос.
                  // Себе самому ряд не предлагаем.
                  rowZone={
                    rowCandidate !== null &&
                    rowCandidate !== g.id &&
                    !rowSide.has(g.id) &&
                    groupCanShareRow(g.blocks)
                  }
                  rail={
                    drag
                      ? drag.kind === 'group' && g.id === drag.overGroup
                        ? 'on'
                        : 'off'
                      : 'auto'
                  }
                  menuForId={menuForId}
                  onAddBelow={handleAddBelow}
                  onInsertBelow={handleInsertBelow}
                  onBackspaceAtStart={handleBackspaceAtStart}
                  onBackspaceDelete={handleBackspaceDelete}
                  onDeleteBlock={handleDeleteBlock}
                  onAnswerAction={handleAnswerAction}
                  onArrow={handleArrow}
                  onRowShift={handleRowShift}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {/* Служебный ярус под полотном: вставка блока мышью и вход в шпаргалку. Указатель
          на Mod+/ стоит здесь потому, что общие клавиши из строк вынесены (§7) — без
          него шпаргалку с ними никто не найдёт. */}
      <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
        {blocks.length > 0 && (
          <button
            type="button"
            onClick={() => handleInsertBelow(blocks[blocks.length - 1]?.id ?? '')}
            className="text-left hover:text-foreground"
          >
            + Добавить блок
          </button>
        )}
        <button
          type="button"
          // mousedown гасим: иначе клик уводит фокус со строки ДО обработчика, активная
          // строка гаснет, и шпаргалка открылась бы без контекста. Заодно Radix вернёт
          // каретку в ту же строку при закрытии.
          onMouseDown={(e) => e.preventDefault()}
          onClick={openSheet}
          className="ml-auto hover:text-foreground"
        >
          {formatLabel('Mod+/')} — горячие клавиши
        </button>
      </div>

      <BlockTypeDialog open={insertOpen} onOpenChange={setInsertOpen} onPick={handlePickInsertType} />

      <ShortcutSheet
        ctx={sheet.ctx}
        open={sheet.open}
        onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}
      />

      <SubmitButtonEditor />
    </div>
    </ActiveRowValueProvider>
    </ActiveRowApiProvider>
    </FocusEngineProvider>
  )
}

// Зоны жеста ряда — третий вид droppable'а, помимо групп и строк. Отдельное
// пространство id (префикс), чтобы фильтр коллизий по слоям их не путал ни с
// groupId, ни с block-id.
const ROW_ZONE = 'rowzone:'
const rowZoneId = (groupId: string) => `${ROW_ZONE}${groupId}`
const rowZoneGroup = (id: string | number): string | null => {
  const s = String(id)
  return s.startsWith(ROW_ZONE) ? s.slice(ROW_ZONE.length) : null
}

// SideDropZone — правая треть ряда со свободной ячейкой (спека §5). Зона узкая
// намеренно: полоса у края холста делала жест «доступным через один» — попасть в неё
// мышью было сложнее, чем в саму цель. Вертикальная линия у правого края горит всё
// время, пока тащат подходящий вопрос (это и есть приглашение), и наливается под
// курсором. Вне потока и pointer-events-none: dnd-kit меряет rect, а не ловит
// события, а занимающий место контрол схлопнул бы строку на mousedown (урок TD-22).
function SideDropZone({ groupId }: { groupId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: rowZoneId(groupId) })
  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 right-0 z-20 w-1/3"
    >
      <span
        className={`absolute inset-y-0 right-0 w-0.5 rounded-full bg-primary transition-opacity ${
          isOver ? 'opacity-100' : 'opacity-30'
        }`}
      />
    </div>
  )
}

// GroupRow — группа как ЕДИНИЦА перетаскивания: один sortable-элемент внешнего
// уровня (li c useSortable по groupId) со всеми строками группы внутри. Драг группы
// полностью нативный: li целиком едет за курсором, соседние группы раздвигаются
// родной анимацией sortable, дроп — родная settle-анимация. Групповую ручку несёт
// только МУЛЬТИ-группа — грип её первой строки (подписи: «подпись владеет группой»)
// получает listeners группы через groupHandle. Одиночки (standalone-контент, голое
// поле, сирота-подпись) тащатся БЛОКОМ — их можно уронить в любую позицию, включая
// середину чужой группы; групповой драг туда не умеет (только границы групп).
// blockIds — ОБЩИЙ список всех block-id полотна: items вложенного SortableContext
// одинаковы у всех групп, чтобы блочный слой был одной сортируемой вселенной
// (глобальные индексы → родная анимация через границы групп; см. коммент у blockIds
// в SlashEditor). Отклик блочного драга над группой — драг-рамка полотна (Д10),
// GroupRow своей подсветки не несёт.
function GroupRow({
  group,
  firstGroup,
  formId,
  blockIds,
  side,
  rowZone,
  rail,
  menuForId,
  onAddBelow,
  onInsertBelow,
  onBackspaceAtStart,
  onBackspaceDelete,
  onDeleteBlock,
  onAnswerAction,
  onArrow,
  onRowShift,
}: {
  group: { id: string; blocks: Block[] }
  // Первая группа полотна: её первая строка — начало формы, у пустого текста там
  // свой плейсхолдер (§7).
  firstGroup: boolean
  formId: string
  blockIds: string[]
  // Сторона в ряду (спека §5): left/right — группа занимает полколонки
  // (calc(50% − 14px), полряда flex-wrap полотна), null — во всю ширину. right
  // зеркалит кластеры значков строк (mirrored у BlockRow) и рейл группы. Ряды видны
  // и во время драга (WYSIWYG) — сторона не гасится.
  side: 'left' | 'right' | null
  // Показывать зону жеста «встань в правую ячейку этого ряда» (решает полотно —
  // только оно знает, что тащат).
  rowZone: boolean
  // Режим рейла: auto — по hover/focus-within (покой), on — горит постоянно
  // (групповой драг над этой группой), off — скрыт (любой другой драг).
  rail: 'auto' | 'on' | 'off'
  menuForId: string | null
  onAddBelow: (id: string, opts?: { openMenu?: boolean; seed?: string; inside?: boolean }) => void
  onInsertBelow: (id: string) => void
  onBackspaceAtStart: (id: string) => void
  onBackspaceDelete: (id: string) => void
  onDeleteBlock: (id: string) => void
  onAnswerAction: (id: string) => void
  onArrow: (id: string, dir: 'up' | 'down') => void
  onRowShift: (id: string, dir: 'left' | 'right') => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.id,
    // Без «доигрывания» анимации после дропа (отскок к старой позиции) — см. dnd.ts.
    animateLayoutChanges: noLayoutAnimation,
  })
  // Translate-only (как у BlockRow): сдвиг без scaleY, чтобы группа не сжималась
  // под высоту соседнего слота при перетаскивании.
  const style = { transform: CSS.Translate.toString(transform), transition }
  // Есть ли в группе контрол ответа: от этого зависит, работает ли Mod+Enter из
  // подписи (handleAnswerAction без отвечаемого блока молчит) — и показывается ли
  // подсказка о нём (§7). Считаем здесь: состав группы знает только GroupRow.
  const hasAnswer = group.blocks.some((b) => isAnswerableType(b.type))
  // Есть ли у группы подпись: от неё зависит, кто управляет строкой ответа. У голого
  // поля (группа без подписи) управлять больше некому — значки остаются на нём.
  const hasCaption = group.blocks.some((b) => isCaptionType(b.type))
  // Отвечаемый блок группы — носитель required. Звёздочку показывает подпись (как в
  // превью и рендерере, §6), а пишет она в это поле; у группы без подписи звёздочка
  // остаётся на самом поле.
  const answerable = group.blocks.find((b) => isAnswerableType(b.type))

  return (
    <li
      ref={setNodeRef}
      style={style}
      // group/grp — именованная Tailwind-группа: `group` без имени занят строками
      // (BlockRow) для своих hover-значков, hover группы должен слушаться отдельно.
      // Ширина — по стороне ряда (спека §5): полколонки минус половина 28px-зазора
      // (= колонка .rf-row превью), иначе вся строка flex-wrap.
      // Мобильный — всегда столбик, тот же брейкпоинт (sm=640), что у .rf-row в
      // fields.css: иначе полколонки остались бы и на телефоне, где у респондента
      // ряд разваливается в стек.
      className={`group/grp relative rounded-md ${
        side ? 'w-full sm:w-[calc(50%-0.875rem)]' : 'w-full'
      } ${isDragging ? 'z-10 opacity-70' : ''}`}
    >
      {/* Рейл — постоянная идентичность МУЛЬТИ-группы (§4.3): тонкая линия в левом
          жёлобе, в покое проявляется по hover/focus-within всей группы; во время
          драга режимом управляет полотно (проп rail — см. SlashEditor). Absolute и
          вне потока (урок TD-22); кластер значков строк отодвинут левее (mr-2.5 в
          BlockRow), чтобы не наезжать. top/bottom-0 = ровно высота текста группы:
          -my-1.5 строк компенсирует их py-1.5, li обнимает чистый контент.
          У правой колонки ряда рейл зеркалится в правый жёлоб — левый занят
          соседней группой. */}
      {group.blocks.length > 1 && rail !== 'off' && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute top-0 bottom-0 w-0.5 rounded-full bg-primary/40 ${
            side === 'right' ? '-right-2' : '-left-2'
          } ${
            rail === 'on'
              ? ''
              : 'opacity-0 transition-opacity group-hover/grp:opacity-100 group-focus-within/grp:opacity-100'
          }`}
        />
      )}
      {rowZone && <SideDropZone groupId={group.id} />}
      <SortableContext items={blockIds} strategy={verticalListSortingStrategy}>
        {/* Внутри вопроса блоки стоят теснее — 14px (gap-3.5), как .rf-group у превью.
            py-1.5 строк скомпенсирован их -my-1.5, поэтому gap = чистый просвет. */}
        <div className="flex flex-col gap-3.5">
          {group.blocks.map((b, i) => (
            <BlockRow
              key={b.id}
              block={b}
              formId={formId}
              groupHandle={
                group.blocks.length > 1 && i === 0 ? { attributes, listeners } : null
              }
              groupHasAnswer={hasAnswer}
              // Строкой ответа в озаглавленной группе управляет подпись, а не она
              // сама: своих значков и своего переноса у неё нет (см. BlockRow).
              ownedByCaption={isAnswerableType(b.type) && hasCaption}
              // Чью обязательность представляет строка: поле — свою, ПЕРВАЯ подпись
              // группы — поля своего вопроса. Прочие строки (контент, вторая подпись)
              // — ничью.
              requiredFor={
                isAnswerableType(b.type) ? b : isCaptionType(b.type) && i === 0 ? answerable : undefined
              }
              // Правая колонка ряда зеркалит кластеры значков (спека §5): левый
              // кластер лёг бы в жёлоб между колонками и наехал на соседа.
              mirrored={side === 'right'}
              // Позиция строки — для контекстного плейсхолдера пустой строки (§7).
              insideQuestion={group.blocks.length > 1 && i > 0}
              firstOfForm={firstGroup && i === 0}
              openMenuOnMount={menuForId === b.id}
              onAddBelow={onAddBelow}
              onInsertBelow={onInsertBelow}
              onBackspaceAtStart={onBackspaceAtStart}
              onBackspaceDelete={onBackspaceDelete}
              onDeleteBlock={onDeleteBlock}
              onAnswerAction={onAnswerAction}
              onArrow={onArrow}
              onRowShift={onRowShift}
            />
          ))}
        </div>
      </SortableContext>
    </li>
  )
}

// SubmitButtonEditor — кнопка отправки формы (всегда видна). Клик открывает поповер
// со сменой её текста; пусто → показывается дефолт. Пишет в стор (форма-уровень),
// автосейв сохраняет вместе со схемой.
function SubmitButtonEditor() {
  const submitLabel = useBuilderStore((s) => s.submitLabel)
  const setSubmitLabel = useBuilderStore((s) => s.setSubmitLabel)
  const label = submitLabel.trim() || DEFAULT_SUBMIT_LABEL

  return (
    // 48px форма→кнопка отправки = gap .rf-page у превью/рендерера (этап 13.3).
    <div className="mt-12">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="rf-submit" title="Нажмите, чтобы изменить текст кнопки">
            {label}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72">
          <Label htmlFor="submit-label" className="text-sm font-medium">
            Текст кнопки отправки
          </Label>
          <Input
            id="submit-label"
            value={submitLabel}
            placeholder={DEFAULT_SUBMIT_LABEL}
            maxLength={MAX_SUBMIT_LABEL_LEN}
            onChange={(e) => setSubmitLabel(e.target.value)}
            className="mt-1.5"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Эту кнопку респондент нажимает, чтобы отправить ответ.
          </p>
        </PopoverContent>
      </Popover>
    </div>
  )
}

// EmptyStarter — пустая форма: инструкция вместо блоков. Фокусируемая область
// перехватывает клавиши: Enter — начать (создать текстовый блок), «/» — вставить
// блок (создать и открыть меню типов), печатный символ — начать текст с него.
function EmptyStarter({
  onStart,
}: {
  onStart: (opts?: { openMenu?: boolean; seed?: string }) => void
}) {
  // Пустое полотно — тоже поверхность карты (§7): Enter/«/»/печатный символ. Блочных
  // клавиш нет — блока ещё не существует.
  const rowFocus = useRowFocus(CANVAS_ROW, 'canvas')

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (chords.enter(e)) {
      e.preventDefault()
      onStart()
    } else if (e.key === '/') {
      e.preventDefault()
      onStart({ openMenu: true })
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      onStart({ seed: e.key })
    }
  }

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={() => onStart()}
      {...rowFocus}
      className="mt-12 cursor-text text-base leading-6 text-muted-foreground/60 outline-none"
    >
      <p>
        Нажмите <Kbd>Enter</Kbd>, чтобы начать
      </p>
      <p>
        Нажмите <Kbd>/</Kbd>, чтобы вставить блок
      </p>
    </div>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
      {children}
    </kbd>
  )
}

// FormTitleInput — название формы как первая строка полотна. Пишет в forms.title
// (отдельная колонка БД, не блок схемы) дебаунс-PATCH'ем через useRenameForm.
// Пустое название не отправляем (совпадает с серверной валидацией: title обязателен).
// Экспортируется ради регресс-теста флаша (titleFlush.test.tsx), полотно рисует её само.
export function FormTitleInput({
  formId,
  initialTitle,
  onEnter,
  titleRef,
}: {
  formId: string
  initialTitle: string
  onEnter: () => void
  // Родитель держит ссылку на textarea заголовка, чтобы вернуть сюда фокус после
  // удаления последнего блока.
  titleRef: RefObject<HTMLTextAreaElement | null>
}) {
  const rename = useRenameForm()
  // Заголовок формы — не блок, поэтому в подсказках адресуется сентинелом (§7):
  // блочных клавиш тут нет, а Enter/↓ уводят на первую строку.
  const rowFocus = useRowFocus(TITLE_ROW, 'title')
  const lastSaved = useRef(initialTitle)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // pending — правка, назначенная к отправке, но ещё не ушедшая (дебаунс не дотикал).
  // null — отправлять нечего.
  const pending = useRef<string | null>(null)
  // Дефолтное имя показываем пустым полем → виден плейсхолдер.
  const initialValue = initialTitle === DEFAULT_FORM_TITLE ? '' : initialTitle

  // flush — унести назначенную правку немедленно, не дожидаясь дебаунса. Зовётся
  // из самого таймера, с blur и с размонтирования.
  //
  // Размонтирование здесь — не редкий путь, а обычный уход с полотна: клик по
  // «Ответы» в шапке, переключение в превью или настройки. Прежде cleanup просто
  // гасил таймер, и название, набранное меньше чем за 800 мс до ухода, пропадало
  // МОЛЧА. Страховка beforeunload автосейва сюда не достаёт: она смотрит store.dirty,
  // а название живёт вне стора билдера (серверный rename отдельной колонки).
  function flush() {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const title = pending.current
    if (title === null) return
    pending.current = null
    rename.mutate({ id: formId, title }, { onSuccess: () => (lastSaved.current = title) })
  }

  // Latest-ref: flush замыкает свежую мутацию, но эффект размонтирования обязан
  // остаться на [] — тот же приём, что у focusEngine и FormsToolbar.
  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  })
  useEffect(() => () => flushRef.current(), [])

  // F5 и закрытие вкладки размонтирования не дают, а flush из обработчика unload не
  // спасёт: браузер отменяет незавершённый fetch. Поэтому здесь — предупреждение, а
  // не сохранение: ровно то, что кабинет уже делает с несохранённой СХЕМОЙ
  // (useAutosave). Без этого название было единственным полем полотна, которое
  // пропадало по F5 совсем молча.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current !== null) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // Поле НЕконтролируемое (defaultValue, без value): контролируемый React-инпут
  // переустанавливает .value на каждый ввод и стирает нативный стек undo элемента,
  // из-за чего Ctrl+Z в названии не работал. Название — серверное состояние вне
  // стора билдера (rename отдельной колонки), в document-undo его не тащим; отдаём
  // отмену браузеру, а он ведёт её сам только у неконтролируемого поля.

  // Автовысота: заголовок — textarea (а не input), чтобы длинное название
  // переносилось так же, как <h1 rf-title> у респондента (единая line-box, без
  // одностроки-переполнения инпута). Растёт под контент, без скролла.
  function resize() {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  // При заходе на форму: подогнать высоту под начальное значение и поставить
  // каретку в начало названия.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    resize()
    el.focus()
    el.setSelectionRange(0, 0)
  }, [])

  function onChange(value: string) {
    resize()
    if (timer.current) clearTimeout(timer.current)
    const trimmed = value.trim()
    // Стёрли до пустого или вернули уже сохранённое — отправлять нечего, и
    // назначенную ранее правку тоже снимаем (иначе flush унёс бы отменённое).
    if (!trimmed || trimmed === lastSaved.current) {
      pending.current = null
      return
    }
    pending.current = trimmed
    timer.current = setTimeout(() => flushRef.current(), 800)
  }

  // Enter/↓ — уйти на первый блок; Enter в заголовке не заводит перевод строки
  // (title однострочный логически, хоть и переносится визуально при отрисовке).
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (chords.enter(e) || chords.arrowDown(e)) {
      e.preventDefault()
      onEnter()
    }
  }

  return (
    <textarea
      ref={(el) => {
        inputRef.current = el
        titleRef.current = el
      }}
      rows={1}
      defaultValue={initialValue}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onFocus={rowFocus.onFocus}
      // Спред {...rowFocus} здесь не годится: свой onBlur затёр бы его. Уход
      // фокуса — самый частый момент «правка закончена», поэтому не ждём дебаунс.
      onBlur={(e) => {
        rowFocus.onBlur(e)
        flush()
      }}
      placeholder="Название формы"
      aria-label="Название формы"
      // Название вне стора билдера (серверный rename) — Ctrl+Z здесь нативный,
      // document-undo билдера его не перехватывает (см. BuilderScreen).
      data-undo-native
      // block: textarea по умолчанию inline-block и оставляет под собой ~7px
      // базлайн-просвета — он раздувал отступ заголовок→первый блок (13.3). Отступ
      // заголовок→блоки целиком задаёт mt-12 (48px) у списка блоков (см. коммент там).
      className="rf-title block w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-muted-foreground/40"
    />
  )
}
