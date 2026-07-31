import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
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
  DEFAULT_SUBMIT_LABEL,
  isAnswerableType,
  isCaptionType,
  MAX_SUBMIT_LABEL_LEN,
  plainText,
  textFromString,
} from '@entities/formSchema'
import {
  groupBlocks,
  groupCanShareRow,
  packGroupRows,
  packRows,
  splitFormTitle,
} from '@fields/groups'
import { useBuilderStore } from './storeContext'
import {
  captionLoss,
  needsCaptionFor,
  planBlockDrop,
  rowBoundaryTarget,
  rowPosition,
} from './store'
import { useCaptionGuard } from './captionGuard'
import { type MenuItem } from './blockTypes'
import { DRAG_ACTIVATION_DISTANCE, noLayoutAnimation } from './dnd'
import { BlockRow } from './BlockRow'
import { FormTitleRow } from './FormTitleRow'
import { type FocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockTypeDialog } from './BlockTypeDialog'
import { chords, formatLabel, type ShortcutContext, type ShortcutFilters } from './shortcuts'
import { useGlobalChord } from './useGlobalChord'
import { ShortcutSheet } from './ShortcutSheet'
import {
  ActiveRowApiProvider,
  ActiveRowValueProvider,
  CANVAS_ROW,
  useActiveRowState,
  useRowFocus,
} from './activeRow'
import { stopNeighbor } from './navigation'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// Дефолтный тип новой строки — «text» (неотвечаемый абзац). Пишешь текст, а «/»
// превращает строку в поле нужного типа — как в Notion/Tally.
const DEFAULT_BLOCK_TYPE = 'text' as const

// Состояние шпаргалки: открыта ли и СНИМОК строки, из которой её позвали (контекст
// карты + признаки, отсеивающие неприменимые пункты).
type SheetState = { open: boolean; ctx: ShortcutContext | null; filters: ShortcutFilters }

// SlashEditor — полотно редактора: название формы первой строкой, ниже блоки как
// редактируемые строки. Фокусом между строками управляет фокус-движок (§2.5):
// строки регистрируют цели, обработчики зовут engine.focusBlock(id). menuForId
// просит свежесозданную строку открыть меню типов (вставка блока по «/»). Стор,
// автосейв и превью — прежние; переписана только поверхность ввода.
export function SlashEditor({
  formId,
  engine,
}: {
  formId: string
  // Фокус-движок создаётся в BuilderScreen (переживает смену режима и нужен undo/redo,
  // §2.4) и раздаётся полотну через контекст.
  engine: FocusEngine
}) {
  const allBlocks = useBuilderStore((s) => s.blocks)
  // Заголовок формы (фаза 15) — блок документа, но рисуется ВНЕ потока вопросов, тем
  // же разделителем, что у превью и рендерера: внутри .rf-form он получил бы ритм
  // «между вопросами» вместо своего. Всё остальное полотно (группы, dnd, обход
  // стрелками, нумерация) работает с потоком БЕЗ заголовка — иначе он оказался бы
  // первой группой и получил бы рейл, значки и сортируемость, которых у него нет.
  const { title: formTitle, rest: blocks } = useMemo(() => splitFormTitle(allBlocks), [allBlocks])
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
  const placeBlockInRow = useBuilderStore((s) => s.placeBlockInRow)
  const takeOwnRow = useBuilderStore((s) => s.takeOwnRow)
  const shiftColumn = useBuilderStore((s) => s.shiftColumn)
  // Драг-рамка (Д10): прямоугольник в координатах полотна (canvasRef), обнимающий
  // union-rect РЕАЛЬНЫХ (трансформированных) rect'ов строк будущего состава группы.
  // Статичный ring на <li> группы врал: sortable раздвигает строки CSS-трансформами,
  // а layout-бокс родителя не меняется — строки визуально уезжали за рамку. Поэтому
  // рамка — absolute-оверлей, который меряет DOM (getBoundingClientRect учитывает
  // трансформы) на каждый onDragMove/onDragOver. У группового драга отклик нативный
  // (sortable двигает группы сам), рамка не участвует.
  const canvasRef = useRef<HTMLDivElement>(null)
  const [frame, setFrame] = useState<Rect | null>(null)
  // Вторая рамка того же цикла (§4.3): строки, которые от ЭТОГО дропа останутся без
  // заголовка. Считается тем же прогнозом planBlockDrop, что и состав основной рамки,
  // и рисуется предупреждающим контуром — цену дропа автор видит ДО того, как отпустит
  // кнопку, а не узнаёт из тоста после.
  const [warnFrame, setWarnFrame] = useState<Rect | null>(null)
  // Линия дропа (§11.6): показывает, КАКОЙ ШИРИНЫ ляжет блок. Во всю ширину — значит
  // полноширинным, из секции вышел; в половину внутри колонки — значит в эту колонку.
  // Ширина и есть ответ: без неё «кладу под секцию» и «кладу в её колонку» на глаз
  // неотличимы (просьба владельца 2026-07-29). Тот же rAF-замер, что у драг-рамки, —
  // события драга молчат, пока строки доигрывают переход.
  const [dropLine, setDropLine] = useState<Rect | null>(null)
  // Цель коллизии, от которой рамка считает состав. Совпадает с e.over везде, кроме
  // подмены границей ряда (rowBoundaryTarget): там полотно кладёт в ref уже
  // подменённую цель — по сырой рамка обвела бы состав, который не сложится.
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
  // Диалог выбора типа (кнопка «+»): открыт ли и после какого блока вставлять
  // (null — в конец).
  const [insertOpen, setInsertOpen] = useState(false)
  const [insertAfterId, setInsertAfterId] = useState<string | null>(null)
  // Активная строка полотна (§7) — источник контекста для чипов и шпаргалки.
  const activeRow = useActiveRowState()
  // Обёртка структурных команд, называющая потерю заголовка (§4.3): см. captionGuard.
  const captionGuard = useCaptionGuard(engine)
  // Шпаргалка Mod+/ (§7, слой 3). Контекст — СНИМОК на момент вызова: открытие диалога
  // уводит фокус с полотна и гасит активную строку, а шпаргалка обязана показывать ту
  // строку, из которой её позвали.
  const [sheet, setSheet] = useState<SheetState>({ open: false, ctx: null, filters: {} })
  // Читать активную строку в оконном слушателе — только через ref: иначе подписка
  // пересоздаётся на каждое движение каретки. В снимок идёт не один контекст, а и
  // признаки строки: шпаргалка — единственная поверхность карты (чипы сняты), и
  // печатать в ней пункт, который на этой строке молчит, значит соврать.
  const snapshotRef = useRef<Omit<SheetState, 'open'>>({ ctx: null, filters: {} })
  const sheetOpenRef = useRef(false)
  useEffect(() => {
    const row = activeRow.active
    snapshotRef.current = {
      ctx: row?.ctx ?? null,
      filters: row
        ? {
            hasAnswer: row.hasAnswer,
            movesRow: row.movesRow,
            // Тем же предикатом, что решает судьбу чипа у строки (needsCaptionFor):
            // обещание шпаргалки и предложение на полотне обязаны совпадать.
            needsCaption: needsCaptionFor(blocks, row.id),
            insideQuestion: row.insideQuestion,
            // Позиция на оси колонок (§11.6) — тем же предикатом, которым ось ведёт стор:
            // подпись пункта обязана называть то, что случится на ЭТОЙ строке. У строки
            // внутри вопроса ось своя (insideQuestion выше), позицию ей не считаем.
            row: row.insideQuestion ? undefined : rowPosition(blocks, row.id),
          }
        : {},
    }
    sheetOpenRef.current = sheet.open
  })
  const openSheet = () => setSheet({ open: true, ...snapshotRef.current })
  // globalThis.KeyboardEvent — нативное событие окна: имя KeyboardEvent в этом файле
  // занято React-синтетическим (импорт сверху). Правило цели — в useGlobalChord: в
  // поле попапа «/» остаётся литералом, а сама шпаргалка (диалог без полей) закрывается
  // тем же аккордом, что открыла.
  useGlobalChord((e: globalThis.KeyboardEvent) => {
    if (!chords.cheatSheet(e)) return
    // Mod+/ — тогл: повторное нажатие при открытой шпаргалке закрывает её, как Esc.
    e.preventDefault()
    if (sheetOpenRef.current) setSheet((s) => ({ ...s, open: false }))
    else setSheet({ open: true, ...snapshotRef.current })
  })

  // dnd-kit: небольшой порог активации, чтобы клик по ручке не начинал перетаскивание;
  // клавиатурный сенсор — доступное перемещение стрелками при захвате ручки. Порог —
  // общая константа (dnd.ts): по нему же грип отличает клик-настройки от хвостового
  // click'а после драга.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }),
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
    for (const [leftCell, rightCell] of packRows(groups)) {
      if (!rightCell) continue
      m.set(leftCell![0]!.id, 'left')
      // В правой колонке — СТОПКА (§5): сторона у всех её групп одна, а полколонки
      // им задаёт ячейка, поэтому ширина каждой остаётся полной внутри ячейки.
      for (const g of rightCell) m.set(g.id, 'right')
    }
    return m
  }, [groups])

  // Жест ряда (спека §5): пока тащат подходящий элемент, у каждого ряда со свободной
  // ячейкой горят обе трети — левая и правая. Кандидат — группа активного элемента:
  // мульти-вопрос едет за ручку подписи (групповой драг), одиночка (голое поле ИЛИ
  // лэйаут-блок) — блочным слоем. Строку из середины чужого вопроса жест не касается:
  // она переносит блок, а не вопрос, и её уровень — ряд ВНУТРИ вопроса (ниже).
  //
  // Требований к типу здесь нет: whitelist отменён (ADR §10), и «можно ли этой группе
  // в ряд» спрашивается у раскладчика одним предикатом — тем же, что рисует ряды.
  const rowCandidate = useMemo(() => {
    if (!drag) return null
    if (drag.kind === 'group') {
      const g = groups.find((x) => x.id === drag.activeId)
      return g && groupCanShareRow(g.blocks) ? g.id : null
    }
    const b = blocks.find((x) => x.id === drag.activeId)
    const g = b && groups.find((x) => x.id === b.groupId)
    return g && g.blocks.length === 1 && groupCanShareRow(g.blocks) ? g.id : null
  }, [drag, groups, blocks])

  // Жест ряда ВНУТРИ вопроса (§6.6): тащат поле из своей мульти-группы → цель ровно
  // одна, первая подпись этой же группы, и зона горит на её строке. Между вопросами
  // такое поле не ходит (rowCandidate выше требует одиночную группу) — уровни не
  // пересекаются, и двух приглашений сразу автор не видит.
  const cellCandidate = useMemo(() => {
    if (drag?.kind !== 'block') return null
    const b = blocks.find((x) => x.id === drag.activeId)
    if (!b || !isAnswerableType(b.type)) return null
    const g = groups.find((x) => x.id === b.groupId)
    if (!g || g.blocks.length < 2) return null
    const caption = g.blocks.find((x) => isCaptionType(x.type))
    if (!caption || caption.id === b.id) return null
    // Ячейка подписи занята (ряд уже собран) — приглашать некуда.
    const row = packGroupRows(g.blocks).find((r) =>
      r.some((c) => c.some((x) => x.id === caption.id)),
    )
    return row?.length === 1 ? caption.id : null
  }, [drag, groups, blocks])

  const collisionDetection: CollisionDetection = (args) => {
    const isGroupDrag = groupIds.has(String(args.active.id))
    // Зоны жеста спрашиваются ПЕРВЫМИ и указателем, а не центрами: зона узкая и
    // намеренная, попадание в неё однозначно, а closestCenter тянул бы её в общий
    // конкурс со строками и мазал. Слоёв это не смешивает — зона отдельный вид
    // droppable'а и из обоих фильтров ниже исключена.
    const zones = args.droppableContainers.filter((c) => isRowZone(c.id))
    if (zones.length > 0) {
      const hit = pointerWithin({ ...args, droppableContainers: zones })
      if (hit.length > 0) return hit
    }
    const collisions = closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (c) => !isRowZone(c.id) && groupIds.has(String(c.id)) === isGroupDrag,
      ),
    })
    if (isGroupDrag || collisions.length === 0) return collisions
    const activeId = String(args.active.id)
    const rawOver = String(collisions[0]!.id)
    rawOverRef.current = rawOver
    // Единственная цель, которую полотно подменяет, — щель между участниками ряда:
    // ряд атомарен для вертикальной вставки (§5), и уронённый туда блок его рвёт, а
    // щель показывала не это. Прежняя вторая подмена (отвечаемый/подпись не падают
    // внутрь чужой мульти-группы) снята фазой 15: дроп туда легален, а его цену
    // называют подсветка жертвы и тост (§4.1, §4.3). Подмена — перестановкой внутри
    // списка closestCenter (там все кандидаты слоя): у dnd-kit over = collisions[0].
    const rowFixed = rowBoundaryTarget(blocks, activeId, rawOver)
    if (!rowFixed) return collisions
    // Рамке тоже отдаём легальную цель: по сырой она обвела бы состав, который
    // после подмены не сложится (блок ляжет под ряд, а не в группу участника).
    rawOverRef.current = rowFixed
    const hit = collisions.find((c) => String(c.id) === rowFixed)
    return hit ? [hit, ...collisions.filter((c) => c !== hit)] : collisions
  }

  // Пересчёт обеих рамок: состав основной отдаёт planBlockDrop (будущая группа
  // активного блока), состав предупреждающей — captionLoss по тому же прогнозу;
  // геометрию обеим даёт живой DOM по data-block-id. Пустой состав (блок остаётся
  // одиночкой; заголовка никто не теряет) — рамки нет.
  // Что замерщику линии нужно знать о документе: состав группы (по нему меряется
  // колонка) и стоит ли цель уже в секции (тогда колонка там, где цель, а не половина
  // от ряда). Геометрию считает он сам по живому DOM.
  const lineCtx = {
    targetInSection: (gid: string) => rowSide.has(gid),
    groupBlockIds: (gid: string) => groups.find((g) => g.id === gid)?.blocks.map((b) => b.id) ?? [],
    // Блоки КОЛОНКИ-получателя: элемент встаёт в её конец (placeInRow якорится за
    // последним), поэтому и линия рисуется под всей колонкой, а не под целью.
    columnBlockIds: (gid: string, side: 'left' | 'right') => {
      const row = packRows(groups).find((r) => r.some((cell) => cell.some((g) => g.id === gid)))
      if (!row || row.length < 2) return []
      return (side === 'left' ? row[0]! : row[1]!).flatMap((g) => g.blocks.map((b) => b.id))
    },
  }

  function updateFrame(activeId: string, overId: string | null) {
    const root = canvasRef.current
    // Цель «сам активный элемент» — не цель: dnd-kit отдаёт её, пока курсор над самим
    // собой, и линия просто ехала бы за блоком, ничего не показывая.
    const over = overId === activeId ? null : (rawOverRef.current ?? overId)
    setDropLine(measureDropLine(root, over, lineCtx))
    if (!root || !overId || groupIds.has(activeId)) {
      setFrame(null)
      setWarnFrame(null)
      return
    }
    const plan = planBlockDrop(blocks, activeId, rawOverRef.current ?? overId)
    // Активная строка следует за курсором по ОБЕИМ осям, и её rect растягивал рамку
    // вбок при горизонтальном дрейфе, хотя горизонтального перемещения у полотна нет:
    // по горизонтали меряем только строки-резиденты. У предупреждающей рамки исключать
    // нечего — жертвой бывает и сама активная строка (поле, уведённое из своего
    // вопроса), и тогда мерить, кроме неё, некого.
    setRect(setFrame, measureUnion(root, plan?.frameIds ?? [], activeId))
    setRect(
      setWarnFrame,
      measureUnion(root, plan ? captionLoss(blocks, plan.blocks).map((l) => l.id) : []),
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
    setWarnFrame(null)
    setDropLine(null)
    rawOverRef.current = null
  }

  // Страховка на анмаунт посреди драга (смена маршрута): rAF-цикл не должен пережить
  // полотно.
  useEffect(() => () => cancelAnimationFrame(frameRafRef.current), [])

  // Дроп по слою: зона жеста → перенос в ряд, группа → перестановка групп, блок →
  // перестановка блоков. Весь дроп идёт через captionGuard: он и называет тостом
  // вопрос, оставшийся без заголовка (§4.3). Обёрнут дроп ЦЕЛИКОМ, а не одна ветка:
  // «эта команда заголовок не отнимает» — знание, которое протухает, а обёртка на
  // безобидной ветке не стоит ничего (потери нет — тоста нет).
  function onDragEnd(e: DragEndEvent) {
    stopFrameLoop()
    const candidate = rowCandidate
    const cellCand = cellCandidate
    setDrag(null)
    const { active, over } = e
    if (!over || active.id === over.id) return
    const zoneTarget = rowZoneTarget(over.id)
    if (zoneTarget !== null) {
      if (candidate) captionGuard(() => placeInRow(candidate, zoneTarget.groupId, zoneTarget.side))
      return
    }
    // Зона второго уровня: ряд внутри вопроса. Заголовка здесь не теряет никто (обе
    // строки остаются в своей группе), но идём через тот же captionGuard — цену
    // структурных команд называет одно место, и исключений у него нет.
    const cellTarget = cellZoneBlock(over.id)
    if (cellTarget !== null) {
      const dragged = String(active.id)
      if (cellCand === cellTarget) captionGuard(() => placeBlockInRow(dragged, cellTarget))
      return
    }
    const activeId = String(active.id)
    if (groupIds.has(activeId)) captionGuard(() => reorderGroups(activeId, String(over.id)))
    else captionGuard(() => reorderBlocks(activeId, String(over.id)))
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
    if (seed) updateBlock(id, { text: textFromString(seed) })
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
    if (formTitle) engine.focusBlock(formTitle.id, 'end')
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
  //
  // «Пусто» считается по ПЛОСКОМУ тексту, а не сравнением поля с пустой строкой:
  // с фазы 14 text — массив спанов, и `(text ?? '') === ''` для него ложно ВСЕГДА
  // (пустой массив не равен пустой строке). Тип это пропускает — `Span[] | ''`
  // пересекается с `''`, поэтому tsc сравнение не запрещает, — и весь жест молча
  // переставал работать: пустая строка не схлопывалась ни в какой ситуации.
  const isBlank = (b: Block) => plainText(b.text) === ''

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
      if (isBlank(cur) && cur.type !== 'text') changeBlockType(cur.id, 'text')
      return
    }
    // Пустой блок схлопываем в предыдущий (фокус в его конец). Подпись владеет
    // группой (решение владельца): Backspace на пустой подписи сносит группу целиком
    // (подпись + контент + поле), а не оставляет осиротевшее голое поле. Предыдущего
    // блока нет — полотно пустеет, каретка на заголовок (не в body). Инпут плейсхолдера
    // перескакиваем (stopNeighbor): каретка встаёт на подпись, а не в поле.
    if (isBlank(cur)) {
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

  // Mod+Alt+→/← — клавиатурное зеркало жеста ряда (§5, §6.6). Каретка не трогается: id
  // блока стабилен, строка не перемонтируется — «каретка едет с блоком» (§2.4).
  //
  // Это ШАГ ПО ОСИ (§11.6), а не тумблер «в ряд / из ряда»: где элемент окажется,
  // зависит от того, где он стоит сейчас, и ось у него ровно одна — полная ширина ↔
  // левая колонка ↔ правая. Саму ось ведёт стор (shiftColumn): цель шага выводится из
  // раскладки, а полотно её не знает.
  //
  // Уровень задаёт МЕСТО строки в группе — тем же правилом, что и смысл бита (§6.3):
  // первая строка (подпись или голое поле) ведёт по оси ВЕСЬ вопрос, любая другая —
  // саму себя по короткой оси ряда внутри вопроса.
  function handleRowShift(id: string, dir: 'left' | 'right') {
    const gid = blocks.find((b) => b.id === id)?.groupId
    if (gid === undefined) return
    const group = groups.find((g) => g.id === gid)
    if (!group) return
    if (group.blocks[0]!.id !== id) {
      // Ряд ВНУТРИ вопроса: пара направленная («подпись | поле»), левой колонки полю не
      // достаётся — остаются вход и выход.
      if (dir === 'left') return takeOwnRow(id)
      const caption = group.blocks.find((b) => isCaptionType(b.type))
      if (caption) placeBlockInRow(id, caption.id)
      return
    }
    shiftColumn(id, dir)
  }

  // Одна группа полотна. Вынесена из JSX функцией, потому что зовут её из двух мест:
  // прямо из ряда-одиночки и из ячейки ряда (стопка групп, §5).
  const renderGroup = (g: (typeof groups)[number]) => (
    <GroupRow
      key={g.id}
      group={g}
      firstGroup={g.id === groups[0]?.id}
      formId={formId}
      blockIds={blockIds}
      side={rowSide.get(g.id) ?? null}
      // Зона жеста — у любой группы, которая может делить секцию, пока тащат подходящий
      // элемент. Себе самому не предлагаем. Группе, УЖЕ стоящей в секции, зону тоже
      // показываем — иначе третий элемент в колонку положить нечем: приглашение значит
      // «встань в эту колонку рядом со мной», а не «открой со мной ряд».
      rowZone={rowCandidate !== null && rowCandidate !== g.id && groupCanShareRow(g.blocks)}
      // Зона второго уровня: id подписи, у которой горит приглашение собрать ряд
      // внутри вопроса (null — не в этой группе).
      cellZone={cellCandidate}
      rail={drag ? (drag.kind === 'group' && g.id === drag.overGroup ? 'on' : 'off') : 'auto'}
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
  )

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
          <div
            ref={canvasRef}
            className="relative mx-auto max-w-[860px] px-5 pb-16 pt-10 sm:px-20 sm:pb-24 sm:pt-24"
          >
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
            {/* Линия дропа (§11.6): ШИРИНА линии = ширина, которой ляжет блок. Во всю —
          полноширинным (из секции вышел), в половину внутри колонки — в эту колонку.
          Оверлей и rAF-замер те же, что у рамок: события драга молчат, пока строки
          доигрывают переход. */}
            {dropLine && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 h-0.5 rounded-full bg-primary"
                style={{
                  transform: `translate(${dropLine.x}px, ${dropLine.y + 13}px)`,
                  width: dropLine.w,
                }}
              />
            )}
            {/* Рамка-предупреждение (§4.3): строка, которая от этого дропа останется без
          заголовка. Тот же оверлей и тот же rAF-замер, что у основной рамки, — иначе
          она отставала бы от расступающихся строк; отличие только в цвете, потому что
          говорит она противоположное: не «сюда встанет», а «отсюда уйдёт имя». */}
            {warnFrame && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 rounded-lg border-2 border-dashed border-destructive/70"
                style={{
                  transform: `translate(${warnFrame.x - 10}px, ${warnFrame.y - 6}px)`,
                  width: warnFrame.w + 20,
                  height: warnFrame.h + 12,
                }}
              />
            )}
            {formTitle && <FormTitleRow block={formTitle} onEnter={focusFirstOrCreate} />}

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
                    d && d.kind === 'group' && d.overGroup !== overId
                      ? { ...d, overGroup: overId }
                      : d,
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
                  {/* Ряды — НАСТОЯЩИЕ контейнеры (а не flex-wrap с шириной в 50%, как было
                до появления стопок): правая колонка ряда может держать НЕСКОЛЬКО
                групп друг под другом (§5), а wrap уложил бы третью полуширинную li
                в начало новой строки, а не в стопку. Разметка теперь совпадает с
                превью и рендерером один в один: .rf-row → .rf-cell → группы.
                DOM-порядок = порядок документа, sortable-вселенная не тронута —
                обёртки не заводят вложенных SortableContext, только лэйаут. */}
                  <ol className="mt-12 flex flex-col gap-7">
                    {packRows(groups).map((row) => {
                      const cellNodes = row.map((cell) => (
                        <div key={cell[0]!.id} className="flex min-w-0 flex-1 flex-col gap-7">
                          {cell.map(renderGroup)}
                        </div>
                      ))
                      return row.length > 1 ? (
                        // Мобильный — стек, тот же брейкпоинт (sm=640), что у .rf-row в
                        // fields.css: иначе полколонки остались бы и на телефоне, где у
                        // респондента ряд разваливается.
                        <div key={row[0]![0]!.id} className="flex flex-col gap-7 sm:flex-row">
                          {cellNodes}
                        </div>
                      ) : (
                        renderGroup(row[0]![0]!)
                      )
                    })}
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

            <BlockTypeDialog
              open={insertOpen}
              onOpenChange={setInsertOpen}
              onPick={handlePickInsertType}
            />

            <ShortcutSheet
              ctx={sheet.ctx}
              filters={sheet.filters}
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

// Rect — прямоугольник в координатах полотна (canvasRef): в них живут обе драг-рамки.
type Rect = { x: number; y: number; w: number; h: number }

// measureDropLine — геометрия линии дропа (§11.6). Отвечает на единственный вопрос:
// какой ШИРИНЫ ляжет блок, — и отвечает самой своей шириной.
//
// Вертикальный дроп всегда даёт ПОЛНУЮ ширину: он снимает бит колонки (правило §5,
// «обычный вертикальный дроп флаг снимает»), то есть выводит блок из секции. Поэтому
// линия во всю ширину = «встанешь полноширинным», и именно её не хватало под секцией:
// на глаз «кладу под секцию» и «кладу в её колонку» неотличимы.
//
// Дроп в зону колонки даёт ПОЛОВИНУ: цель уже в секции → берём её собственную
// геометрию (колонка ровно там, где стоит цель); цель полноширинная → секция только
// создаётся, и половина считается от ряда за вычетом 28px-жёлоба.
function measureDropLine(
  root: HTMLElement | null,
  overId: string | null,
  ctx?: {
    targetInSection: (gid: string) => boolean
    groupBlockIds: (gid: string) => string[]
    columnBlockIds: (gid: string, side: 'left' | 'right') => string[]
  },
): Rect | null {
  if (!root || !overId) return null
  const list = root.querySelector<HTMLElement>('ol')
  if (!list) return null
  const cr = root.getBoundingClientRect()
  const lr = list.getBoundingClientRect()
  const x0 = lr.left - cr.left
  const zone = rowZoneTarget(overId)
  const cell = cellZoneBlock(overId)
  if (zone === null && cell === null) {
    // Вертикальная вставка: линия во всю ширину, по НИЖНЕЙ границе цели — туда блок и
    // ложится, а «выше цели» показывает уже раздвинутая sortable щель.
    const el = root.querySelector<HTMLElement>(`[data-block-id="${overId}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: x0, y: r.bottom - cr.top, w: lr.width, h: 0 }
  }
  const gid = zone?.groupId
  const inSection = gid !== undefined && (ctx?.targetInSection(gid) ?? false)
  if (inSection) {
    // Цель уже в секции: линия под ВСЕЙ колонкой-получателем и её ширины — туда
    // элемент и ляжет, в конец колонки.
    const col = measureUnion(root, ctx?.columnBlockIds(gid, zone!.side) ?? [])
    return col && { x: col.x, y: col.y + col.h, w: col.w, h: 0 }
  }
  const ids = gid !== undefined ? (ctx?.groupBlockIds(gid) ?? []) : cell !== null ? [cell] : []
  const target = measureUnion(root, ids)
  if (!target) return null
  // Секция только создаётся: половина считается от ряда за вычетом 28px-жёлоба.
  const half = (lr.width - 28) / 2
  const rightSide = zone?.side === 'right'
  return { x: rightSide ? x0 + lr.width - half : x0, y: target.y, w: half, h: 0 }
}

// measureUnion — union-rect строк с данными id по ЖИВОМУ DOM: getBoundingClientRect
// учитывает трансформы, которыми sortable раздвигает строки, а layout-бокс — нет
// (из-за этого рамка и рисуется оверлеем, а не ring'ом на группе). skipX — строка,
// не участвующая в ГОРИЗОНТАЛЬНОМ замере (активная следует за курсором по обеим
// осям). null — мерить нечего.
function measureUnion(root: HTMLElement, ids: string[], skipX?: string): Rect | null {
  if (ids.length === 0) return null
  const cr = root.getBoundingClientRect()
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const id of ids) {
    const el = root.querySelector<HTMLElement>(`[data-block-id="${id}"]`)
    if (!el) continue
    const r = el.getBoundingClientRect()
    top = Math.min(top, r.top)
    bottom = Math.max(bottom, r.bottom)
    if (id === skipX) continue
    left = Math.min(left, r.left)
    right = Math.max(right, r.right)
  }
  if (left === Infinity || top === Infinity) return null
  return { x: left - cr.left, y: top - cr.top, w: right - left, h: bottom - top }
}

// setRect — бэйл на эквивалентный прямоугольник: замер гонит rAF-цикл, и setState
// тем же значением каждый кадр перерисовывал бы полотно посреди драга впустую.
function setRect(set: Dispatch<SetStateAction<Rect | null>>, next: Rect | null): void {
  set((p) =>
    p === next ||
    (p && next && p.x === next.x && p.y === next.y && p.w === next.w && p.h === next.h)
      ? p
      : next,
  )
}

// Зоны жеста ряда — третий вид droppable'а, помимо групп и строк. Отдельное
// пространство id (префикс), чтобы фильтр коллизий по слоям их не путал ни с
// groupId, ни с block-id.
const ROW_ZONE = 'rowzone:'
const rowZoneId = (groupId: string, side: 'left' | 'right') => `${ROW_ZONE}${side}:${groupId}`
// Возвращает цель И сторону: с какой стороны отпустили кнопку, с той элемент и встаёт
// (решение владельца 2026-07-29). Без левой зоны «поставить блок слева от вопроса»
// требовало тащить не тот элемент, о котором думает автор.
const rowZoneTarget = (id: string | number): { groupId: string; side: 'left' | 'right' } | null => {
  const s = String(id)
  if (!s.startsWith(ROW_ZONE)) return null
  const rest = s.slice(ROW_ZONE.length)
  const at = rest.indexOf(':')
  return { side: rest.slice(0, at) as 'left' | 'right', groupId: rest.slice(at + 1) }
}

// Зона второго уровня (§6.6): правая треть строки ПОДПИСИ, пока тащат поле её же
// группы. Своё пространство id по той же причине, что у зоны ряда, — и отдельное от
// неё: цель здесь блок, а не группа, и путать их фильтру коллизий нельзя.
const CELL_ZONE = 'cellzone:'
const cellZoneId = (blockId: string) => `${CELL_ZONE}${blockId}`
const cellZoneBlock = (id: string | number): string | null => {
  const s = String(id)
  return s.startsWith(CELL_ZONE) ? s.slice(CELL_ZONE.length) : null
}
const isRowZone = (id: string | number): boolean =>
  rowZoneTarget(id) !== null || cellZoneBlock(id) !== null

// SideDropZone — треть ряда со свободной ячейкой (спека §5), с той стороны, с какой
// элемент встанет. Зона узкая намеренно: полоса у края холста делала жест «доступным
// через один» — попасть в неё мышью было сложнее, чем в саму цель. Вертикальная линия
// у края горит всё время, пока тащат подходящий элемент (это и есть приглашение), и
// наливается под курсором. Вне потока и pointer-events-none: dnd-kit меряет rect, а
// не ловит события, а занимающий место контрол схлопнул бы строку на mousedown
// (урок TD-22).
function SideDropZone({ groupId, side }: { groupId: string; side: 'left' | 'right' }) {
  const { setNodeRef, isOver } = useDroppable({ id: rowZoneId(groupId, side) })
  const edge = side === 'right' ? 'right-0' : 'left-0'
  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-y-0 ${edge} z-20 w-1/3`}
    >
      <span
        className={`absolute inset-y-0 ${edge} w-0.5 rounded-full bg-primary transition-opacity ${
          isOver ? 'opacity-100' : 'opacity-30'
        }`}
      />
    </div>
  )
}

// CellDropZone — та же зона на строке подписи (§6.6): дроп собирает ряд ВНУТРИ
// вопроса. Вид и правила те же, что у SideDropZone, — жест один, уровень разный, и
// выглядеть они обязаны одинаково.
function CellDropZone({ blockId }: { blockId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: cellZoneId(blockId) })
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
  cellZone,
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
  // Тот же вопрос на втором уровне (§6.6): id ПОДПИСИ, у которой горит приглашение
  // собрать ряд внутри вопроса. Не из этой группы или null — зоны нет.
  cellZone: string | null
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
      // Ширину группа себе больше НЕ считает: полколонки задаёт ячейка ряда (см. ol в
      // SlashEditor), как .rf-cell у превью. Прежний calc(50% − 14px) на самой li был
      // нужен, пока ряды складывались flex-wrap'ом; со стопкой в колонке это перестало
      // работать — третья полуширинная li уезжала на новую строку вместо стопки.
      className={`group/grp relative w-full rounded-md ${isDragging ? 'z-10 opacity-70' : ''}`}
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
      {/* Зона = «встань в ЭТУ колонку», и рисуется она на той стороне РЯДА, где эта
          колонка стоит. Поэтому участник левой колонки предлагает только левую, правой
          — только правую: иначе в 28px-жёлобе сходились бы две зоны с противоположным
          смыслом («в правую» от левого участника и «в левую» от правого), и попадание
          читалось бы наоборот. Полноширинная группа предлагает обе — её бокс и есть
          весь ряд, а секция только создаётся. */}
      {rowZone && side !== 'right' && <SideDropZone groupId={group.id} side="left" />}
      {rowZone && side !== 'left' && <SideDropZone groupId={group.id} side="right" />}
      <SortableContext items={blockIds} strategy={verticalListSortingStrategy}>
        {/* Внутри вопроса блоки стоят теснее — 14px (gap-3.5), как .rf-group у превью.
            py-1.5 строк скомпенсирован их -my-1.5, поэтому gap = чистый просвет. */}
        <div className="flex flex-col gap-3.5">
          {/* Второй уровень рядов (фаза 15, §6.4/§6.7): пара «подпись | поле» встаёт
              бок о бок. Раскладчик тот же, что у превью и рендерера (packGroupRows),
              и вид тот же: зазор 14px (gap-3.5 = .rf-group) и выравнивание по центру
              (items-center = align-items у .rf-group > .rf-row). Ряд из одного
              остаётся прямой строкой колонки — лишняя обёртка сместила бы кластеры. */}
          {packGroupRows(group.blocks).map((innerRow) => {
            // Внутри вопроса стопки не бывает (пара — «подпись + поле», а отвечаемый
            // блок в группе один), поэтому ячейка здесь всегда об одном блоке.
            const render = (b: Block) => {
              const i = group.blocks.indexOf(b)
              return (
                <BlockRow
                  key={b.id}
                  block={b}
                  formId={formId}
                  groupHandle={
                    group.blocks.length > 1 && i === 0 ? { attributes, listeners } : null
                  }
                  groupHasAnswer={hasAnswer}
                  // Чью обязательность представляет строка: ПЕРВАЯ подпись группы — поля
                  // своего вопроса, поле БЕЗ подписи — своё. Прочие строки (контент,
                  // вторая подпись) — ничью, и поле озаглавленного вопроса тоже: звёздочка
                  // одна на вопрос и стоит там же, где у превью и рендерера (§6). Кластер
                  // значков у такого поля с фазы 15 есть, а звёздочка — по-прежнему нет:
                  // это не управление строкой, а свойство вопроса.
                  requiredFor={
                    isCaptionType(b.type) && i === 0
                      ? answerable
                      : isAnswerableType(b.type) && !hasCaption
                        ? b
                        : undefined
                  }
                  // Правая колонка ряда зеркалит кластеры значков (спека §5): левый
                  // кластер лёг бы в жёлоб между колонками и наехал на соседа. Правая
                  // ячейка ряда ВНУТРИ вопроса — тот же случай, тот же ответ.
                  mirrored={
                    side === 'right' || (innerRow.length > 1 && innerRow[1]![0]!.id === b.id)
                  }
                  // Зона жеста «встань со мной в ряд» — на строке подписи, пока
                  // тащат поле её же группы (§6.6). Цель считает полотно: строка
                  // соседей не знает.
                  rowZone={cellZone === b.id ? <CellDropZone blockId={b.id} /> : undefined}
                  // Голой строке ответа предлагается дать заголовок (§4.4 спеки фазы 15):
                  // тем же предикатом, которым шпаргалка решает, обещать ли Mod+Alt+T.
                  // Хватает блоков ГРУППЫ: подпись, если она есть, лежит здесь же.
                  needsCaption={needsCaptionFor(group.blocks, b.id)}
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
              )
            }
            return innerRow.length > 1 ? (
              <div key={innerRow[0]![0]!.id} className="flex items-center gap-3.5">
                {innerRow.map((cell) => (
                  // min-w-0 обязателен, как у .rf-cell: без него длинная подпись не
                  // даёт колонке ужаться и ломает 50/50.
                  <div key={cell[0]!.id} className="min-w-0 flex-1">
                    {cell.map(render)}
                  </div>
                ))}
              </div>
            ) : (
              render(innerRow[0]![0]!)
            )
          })}
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
