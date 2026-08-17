import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  DndContext,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { toast } from 'sonner'
import {
  type Block,
  DEFAULT_SUBMIT_LABEL,
  isAnswerableType,
  isCaptionType,
  MAX_COLUMNS,
  MAX_SUBMIT_LABEL_LEN,
  plainText,
  textFromString,
} from '@entities/formSchema'
import { BlockField } from '@fields/BlockField'
import { designClasses, designToVars } from '@fields/design'
import {
  groupBlocks,
  groupCanPair,
  groupMeta,
  packGroupRows,
  packRows,
  splitFormTitle,
} from '@fields/groups'
import { useBuilderStore, useBuilderStoreApi } from './storeContext'
import { captionLoss, needsCaptionFor, planBlockDrop, rowPosition } from './store'
import { inviteRowId } from './rowZones'
import { type Box, type DropTarget, pickDropTarget, pickHoverGroup } from './dropTarget'
import { useCaptionGuard } from './captionGuard'
import { type MenuItem } from './blockTypes'
import {
  canvasSorting,
  DRAG_ACTIVATION_DISTANCE,
  DRAGGED_FADE,
  DRAGGED_LOOK,
  flatRect,
  noLayoutAnimation,
} from './dnd'
import {
  CellDropZone,
  DropLine,
  FootDropZone,
  GapDropZone,
  GhostFrame,
  SideDropZone,
  SourceSlot,
} from './dragChrome'
import { measureLine, measureSlot, measureUnion, type Rect, setRect } from './dragMeasure'
import { BlockRow } from './BlockRow'
import { AddChrome, CoverArea, LogoArea } from './CoverEditor'
import { FormTitleRow } from './FormTitleRow'
import { type FocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockTypeDialog } from './BlockTypeDialog'
import { chords, type ShortcutContext, type ShortcutFilters } from './shortcuts'
import { useGlobalChord } from './useGlobalChord'
import { ShortcutSheet } from './ShortcutSheet'
import {
  type ActiveRow,
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
  onOpenDesign,
}: {
  formId: string
  // Фокус-движок создаётся в BuilderScreen (переживает смену режима и нужен undo/redo,
  // §2.4) и раздаётся полотну через контекст.
  engine: FocusEngine
  // Открыть шторку оформления. Пропом, а не через стор: состояние шторки — UI
  // экрана, а не документа, и живёт оно в BuilderScreen рядом с кнопкой в шапке.
  onOpenDesign: () => void
}) {
  const allBlocks = useBuilderStore((s) => s.blocks)
  // Обложка нужна полотну только затем, чтобы поджать верхний отступ: сама она
  // рисуется внутри CoverArea.
  const cover = useBuilderStore((s) => s.cover)
  // Подписка ТОЧЕЧНАЯ, на s.design, а не на стор целиком: полотно перерисовывается
  // на каждый символ, и подписка на что-то, меняющееся при вводе, обходит memo строк
  // (фаза 21 поймала этот класс дважды — STATUS.md).
  const design = useBuilderStore((s) => s.design)
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
  // Сам стор, без подписки: обработчики строк читают документ В МОМЕНТ ВЫЗОВА, а не
  // берут значение с рендера. Это и есть то, что делает их ссылки стабильными
  // (useCallback без зависимости от blocks), а стабильные ссылки — условие, без
  // которого memo на строках не срабатывает вовсе (TD-32). Значение с рендера здесь
  // не просто лишняя зависимость: обработчики правят СОСТАВ документа по индексам,
  // и работать они обязаны с тем документом, который есть сейчас.
  const storeApi = useBuilderStoreApi()
  // Поток вопросов БЕЗ заголовка формы — тот же срез, что и `blocks` выше: обработчики
  // ходят по нему индексами (stopNeighbor, findIndex), и заголовок в списке сдвинул бы
  // все соседства на единицу.
  const readBlocks = useCallback(() => splitFormTitle(storeApi.getState().blocks).rest, [storeApi])
  // Координатный якорь оверлеев драга (рейл будущей группы, предупреждающая рамка):
  // они absolute-прямоугольники в системе полотна и меряют DOM относительно него.
  const canvasRef = useRef<HTMLDivElement>(null)
  // ИЗМЕРЕННОГО РЕЙЛА БУДУЩЕЙ ГРУППЫ ЗДЕСЬ НЕТ (решение владельца 2026-08-11), и вернуть
  // его нельзя, не вернув расступание: он лечил враньё layout-бокса, пока sortable
  // раздвигал строки трансформами, а при неподвижной раскладке (§5.2) лечить нечего.
  // Рейл у групп только свой, статичный (GroupRow, проп rail).
  //
  // Предупреждающая рамка (§4.3): строки, которые от ЭТОГО дропа останутся без
  // заголовка. Состав даёт прогноз planBlockDrop, а рисуется он предупреждающим
  // контуром — цену дропа автор видит ДО того, как отпустит кнопку, а не узнаёт из
  // тоста после.
  //
  // Про МЕСТО вставки она не говорит ничего — это работа ЛИНИИ (dropLine ниже). Говорить
  // о месте обязан ровно ОДИН элемент: пока их было двое (линия и щель между
  // расступившимися строками), они расходились между собой.
  const [warnFrame, setWarnFrame] = useState<Rect | null>(null)
  // ЛИНИЯ ВСТАВКИ (2026-08-11) — то, что говорит «сюда встанет», вместо расступания
  // строк. Соседи неподвижны, поэтому цель не уезжает из-под курсора; линия рисуется
  // оверлеем по живым rect'ам, как рамка, и живёт ровно столько же.
  const [dropLine, setDropLine] = useState<Rect | null>(null)
  // ГОСТ ИСТОЧНИКА (решение владельца 2026-08-11): тусклая копия в СЛОТЕ, из которого
  // элемент вынули. Стоит там от захвата до дропа и не двигается — отвечает на «откуда
  // я это взял», пока линия отвечает на «куда встанет».
  //
  // Нужен он потому, что элемент едет за курсором ТРАНСФОРМОМ: его layout-бокс остаётся
  // на месте, но пустой, и на полотне появляется дыра ровно в рост строки. С 2026-08-12
  // это ЕДИНСТВЕННАЯ тусклая копия на полотне: дублёр, показывавший результат на будущем
  // месте, снят (§5.1), и `GhostFrame` остался только здесь.
  const [sourceGhost, setSourceGhost] = useState<Rect | null>(null)
  // ЦЕЛЬ ЖЕСТА — один ответ на всё: где линия, что за прогноз дропа и какую команду
  // выполнит отпускание кнопки. Считает её `pickDropTarget` по УКАЗАТЕЛЮ (dropTarget.ts),
  // а не dnd-kit по центрам, поэтому она и живёт в ref, а не выводится из `e.over`:
  // `over` остаётся у dnd-kit ради его собственных нужд (drop-анимация, клавиатурный
  // сенсор), но полотну он больше ничего не сообщает. Один источник вместо прежних
  // двух (сырая цель + подменённая) — расходиться нечему.
  const targetRef = useRef<DropTarget | null>(null)
  // Во время драга рейлом групп управляет не hover (курсор с таскаемым элементом
  // мельтешит по hover-зонам — рейл мигал), а состояние: групповой драг зажигает
  // рейл у группы-цели постоянно, блочный — гасит рейлы совсем: рейлы мульти-групп
  // по всему полотну спорят с оверлеями жеста за внимание.
  const [drag, setDrag] = useState<{
    kind: 'group' | 'block'
    activeId: string
    overGroup: string | null
  } | null>(null)
  // Ближайшее к перетаскиваемому элементу место — ЕДИНСТВЕННОЕ, где горит приглашение
  // «встань в ряд» (решение владельца 2026-08-02; правило и его причина — `rowZones.ts`).
  // Место берётся у ТОЙ ЖЕ цели, что рисует линию (pickDropTarget пишет её в ref), а в
  // состояние его переносит rAF-цикл кадра — события драга молчат, пока строки
  // доигрывают переход. Своего конкурса здесь нет и заводить его нельзя: приглашение
  // загоралось бы не у того ряда, куда показывает линия, — два ответа на один вопрос.
  const [nearGroup, setNearGroup] = useState<string | null>(null)
  const nearGroupRef = useRef<string | null>(null)
  // ЗОНА ПОД КУРСОРОМ — своё состояние полотна, а не `over` у dnd-kit (2026-08-12).
  // Ею приглашение ПРИБИТО к ряду, пока курсор внутри (иначе ряд, выбранный по
  // указателю, сменился бы соседом ровно в момент захода в зону — жест погасил бы сам
  // себя), ею же горит полоса и исполняется дроп.
  //
  // Отдать зону в `over` нельзя, и это не вкус: id зоны не лежит ни в одном списке
  // `SortableContext`, поэтому `overIndex` у dnd-kit становится −1, `displaceItem` —
  // ложью, и активный элемент теряет трансформу (см. `idleOverId`). Блок «вщёлкивался»
  // обратно в свой слот — поверх госта источника, отчего казалось, что под курсором
  // подменили копию (найдено владельцем). Поэтому dnd-kit получает сортируемый
  // droppable всегда, а зону полотно ведёт само.
  //
  // В состоянии лежит СЫРОЙ id, а не разобранная зона: строка сравнивается по значению,
  // и setState тем же id React гасит сам. Свежий объект каждый кадр стоил бы полного
  // ре-рендера полотна 60 раз в секунду (§5.3).
  const [zoneId, setZoneId] = useState<string | null>(null)
  const zoneRef = useRef<string | null>(null)
  const hoverZone = useMemo<RowZone | null>(
    () => (zoneId === null ? null : rowZoneTarget(zoneId)),
    [zoneId],
  )
  const hoverCell = useMemo(() => (zoneId === null ? null : cellZoneBlock(zoneId)), [zoneId])
  // Замер оверлеев гонит rAF-цикл, а не события драга: активная строка доигрывает свой
  // CSS-переход (200мс) и после остановки курсора, onDragMove в это время молчит —
  // оверлеи отставали от неё. Цикл меряет каждый кадр; аргументы (активный элемент и
  // строки его слота) кладёт onDragStart. Пустой ref = цикл остановлен.
  const frameArgsRef = useRef<{ activeId: string; sourceIds: string[] } | null>(null)
  const frameRafRef = useRef(0)
  // Прогноз дропа под текущую цель: состав предупреждающей рамки.
  // Пересчитывается на смене цели, а не каждый кадр (см. updateFrame).
  const planRef = useRef<{
    key: string | null
    lossIds: string[]
  } | null>(null)
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
  // пересоздаётся на каждое движение каретки.
  //
  // В ref лежит СЫРАЯ строка, а всё производное считается в момент вызова. Собирать
  // снимок эффектом нельзя: `rowPosition` гоняет полный раскладчик (rowGroups +
  // packRows), и каждое нажатие клавиши стоило бы прохода по всей форме ради снимка,
  // который открывают раз в сессию. Считать в момент вызова безопасно: аккорд приходит,
  // пока полотно ещё в фокусе и активная строка та самая, — диалог уводит фокус уже
  // после.
  const rowRef = useRef<ActiveRow | null>(null)
  const blocksRef = useRef(blocks)
  const sheetOpenRef = useRef(false)
  useEffect(() => {
    rowRef.current = activeRow.active
    blocksRef.current = blocks
    sheetOpenRef.current = sheet.open
  })
  // Снимок строки для шпаргалки: не один контекст, а и признаки строки — шпаргалка
  // единственная поверхность карты (чипы сняты), и печатать в ней пункт, который на этой
  // строке молчит, значит соврать.
  const snapshot = (): Omit<SheetState, 'open'> => {
    const row = rowRef.current
    const blocksNow = blocksRef.current
    return {
      ctx: row?.ctx ?? null,
      filters: row
        ? {
            hasAnswer: row.hasAnswer,
            movesRow: row.movesRow,
            // Тем же предикатом, что решает судьбу чипа у строки (needsCaptionFor):
            // обещание шпаргалки и предложение на полотне обязаны совпадать.
            needsCaption: needsCaptionFor(blocksNow, row.id),
            insideQuestion: row.insideQuestion,
            // Позиция на оси колонок (§11.6) — тем же предикатом, которым ось ведёт стор:
            // подпись пункта обязана называть то, что случится на ЭТОЙ строке. У строки
            // внутри вопроса ось своя (insideQuestion выше), позицию ей не считаем.
            row: row.insideQuestion ? undefined : rowPosition(blocksNow, row.id),
          }
        : {},
    }
  }
  // globalThis.KeyboardEvent — нативное событие окна: имя KeyboardEvent в этом файле
  // занято React-синтетическим (импорт сверху). Правило цели — в useGlobalChord: в
  // поле попапа «/» остаётся литералом, а сама шпаргалка (диалог без полей) закрывается
  // тем же аккордом, что открыла.
  useGlobalChord((e: globalThis.KeyboardEvent) => {
    if (!chords.cheatSheet(e)) return
    // Mod+/ — тогл: повторное нажатие при открытой шпаргалке закрывает её, как Esc.
    e.preventDefault()
    if (sheetOpenRef.current) setSheet((s) => ({ ...s, open: false }))
    else setSheet({ open: true, ...snapshot() })
  })

  // dnd-kit: небольшой порог активации, чтобы клик по ручке не начинал перетаскивание;
  // клавиатурный сенсор — доступное перемещение стрелками при захвате ручки. Порог —
  // общая константа (dnd.ts): по нему же грип отличает клик-настройки от хвостового
  // click'а после драга.
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_OPTIONS),
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
  // строка едет через границы групп. Нарезка items по группам ломала драг: over в
  // чужом контексте → overIndex −1 → dnd-kit гасит все трансформы (элемент замирал
  // под мышкой). Слои НЕ конкурируют за цель: слой активного задаёт ЛИСТ ОБХОДА в
  // pickDropTarget — тащат группу → целями работают группы, тащат строку → блоки. Без
  // такого разделения выбор цели мечется между контейнером группы и её строками, то
  // есть джиттер.
  // Разбиение — общий groupBlocks (@fields/groups), тот же, которым пакуют группы
  // превью и рендерер. Здесь стояла его побайтовая копия: единый раскладчик, ради
  // которого модуль и заведён, на одной из трёх поверхностей не использовался.
  const groups = useMemo(() => groupBlocks(blocks), [blocks])
  // groupIdList ОБЯЗАН быть стабильной ссылкой между ре-рендерами драга (как и
  // blockIds): items внешнего SortableContext сравниваются в useSortable по
  // ссылке (itemsHaveChanged), и свежий массив на рендере, где группа начинает
  // смещаться, отключает её transition — группа телепортируется вместо сдвига.
  // Ре-рендеры во время драга есть: setDrag (рейл цели) и rAF-цикл оверлеев.
  //
  // МЕЖДУ нажатиями клавиш ссылка обязана быть стабильной по второй причине:
  // SortableContext пересобирает по items значение своего контекста, а оно протягивается
  // через КАЖДЫЙ useSortable полотна — все строки и все группы, мимо любого memo (тот же
  // propagateContextChange, что у POINTER_OPTIONS). Один свежий массив на символ
  // обесценивает мемоизацию строк целиком. Поэтому списки id считаются от СОДЕРЖИМОГО
  // (useIdList), а не от идентичности массива-источника.
  const groupIdList = useIdList(groups)
  const groupIds = useMemo(() => new Set(groupIdList), [groupIdList])
  const blockIds = useIdList(blocks)

  // Ряды видны ВСЕГДА, включая время драга: в столбике ряд распадается и появляется
  // цель «между левым и правым», которая после упаковки значит не то, что показала.
  // В двумерном полотне такой цели нет — вертикально вставляются между рядами, и
  // позиция «между участниками» в набор целей просто не попадает (dropTarget.ts).
  const rows = useMemo(() => packRows(groups), [groups])
  // Группы, стоящие в СЕКЦИИ. Стороны здесь не считают: при четырёх колонках зеркалить
  // некуда — у средних колонок «своей» стороны нет вовсе, — поэтому кластер значков у
  // всех слева, а от наезда на соседа его держит подложка в цвет холста (BlockRow).
  // Карта нужна ради одного вопроса: стоит ли вопрос в секции (тогда он не показывает
  // зону второго уровня).
  const inSection = useMemo(
    () => new Set(rows.filter((r) => r.length > 1).flatMap((r) => r.flat().map((g) => g.id))),
    [rows],
  )

  // Жест ряда (спека §5): пока тащат подходящий элемент, у БЛИЖАЙШЕГО ряда горят обе
  // полосы — левая и правая. Кандидат — группа активного элемента:
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
      return g && groupCanPair(g.blocks) ? g.id : null
    }
    const b = blocks.find((x) => x.id === drag.activeId)
    const g = b && groups.find((x) => x.id === b.groupId)
    return g && g.blocks.length === 1 && groupCanPair(g.blocks) ? g.id : null
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
    // Вопрос, стоящий в СЕКЦИИ, приглашения не показывает: ряд внутри вопроса делает
    // группу полноширинной (groupCanShareRow = «внутреннего ряда нет»), то есть дроп
    // молча развалил бы секцию, в которой вопрос стоит, — обещание зоны и её
    // последствие разошлись бы. Заодно снаружи такого вопроса нет поля полотна: зона
    // легла бы в 28px-жёлоб и наехала на соседнюю колонку.
    if (inSection.has(g.id)) return null
    const caption = g.blocks.find((x) => isCaptionType(x.type))
    if (!caption || caption.id === b.id) return null
    // Ячейка подписи занята (ряд уже собран) — приглашать некуда.
    const row = packGroupRows(g.blocks).find((r) =>
      r.some((c) => c.some((x) => x.id === caption.id)),
    )
    return row?.length === 1 ? caption.id : null
  }, [drag, groups, blocks, inSection])

  // Чем занять `over`, когда цели дропа нет (см. вызов): вопросом под указателем, а на
  // блочном слое — его последней живой строкой. Полотно от этого ничего не получает,
  // это плата за устройство useSortable. Совсем пусто бывает на форме из одного блока
  // (кроме активного целей нет вовсе) — тогда сам активный, лишь бы не пустота.
  function idleOverId(hoverGroup: string | null, isGroupDrag: boolean, activeId: string): string {
    if (hoverGroup === null) return activeId
    if (isGroupDrag) return hoverGroup
    const rows = groups.find((g) => g.id === hoverGroup)?.blocks ?? []
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.id !== activeId) return rows[i]!.id
    }
    return activeId
  }

  const collisionDetection: CollisionDetection = (args) => {
    const isGroupDrag = groupIds.has(String(args.active.id))
    // ЗОНЫ ЖЕСТА спрашиваются первыми и указателем: зона намеренная, попадание в неё
    // однозначно, и своя команда у неё тоже своя (placeInRow, не перенос). Слоёв это не
    // смешивает — зона отдельный вид droppable'а со своим пространством id.
    //
    // Ответ кладётся в ref полотна, а НЕ отдаётся dnd-kit коллизией: зона не сортируемый
    // элемент, и её `over` стоил бы активному блоку трансформы (см. состояние зоны).
    const zones = args.droppableContainers.filter((c) => isRowZone(c.id))
    const zoneHit =
      zones.length === 0 ? [] : pointerWithin({ ...args, droppableContainers: zones })
    zoneRef.current = zoneHit.length > 0 ? String(zoneHit[0]!.id) : null
    if (zoneRef.current !== null) {
      // Вертикальную цель гасим: она осталась от последнего кадра ВНЕ зоны, и по ней
      // полотно рисовало бы линию к дропу, которого не будет. Ближайший ряд, наоборот,
      // не трогаем: приглашение обязано остаться прибитым к зоне, пока курсор в ней.
      targetRef.current = null
      const idle = idleOverId(nearGroupRef.current, isGroupDrag, String(args.active.id))
      const stay = args.droppableContainers.find((c) => String(c.id) === idle)
      return stay ? [{ id: stay.id, data: { droppableContainer: stay, value: 0 } }] : []
    }
    // ПРИЦЕЛ — УКАЗАТЕЛЬ. Клавиатурному драгу указателя не выдают вовсе, и другой точки,
    // выражающей намерение, в нём нет — остаётся центр едущего элемента (сенсор двигает
    // именно его). ЖЕСТА ПОД ЭТУ ВЕТКУ НЕТ, и подпорка ею быть не может: клавиатурный
    // перенос на полотне — это Alt+↑/↓, грип из обхода Tab исключён намеренно
    // (BlockRow), а сама ветка правило прицеливания не вытягивает. Шаг вверх
    // sortableKeyboardCoordinates выравнивает ВЕРХ активного по верху цели, то есть
    // центр приезжает внутрь цели, «линия под целью» называет место, где элемент и
    // стоял, — Space-драг вверх был бы no-op'ом, а первая позиция недостижимой.
    // Правило про указатель ради него не гнём: чинить это нужно вместе с решением,
    // нужен ли Space-драг вообще (сейчас он никому не виден).
    const point =
      args.pointerCoordinates ??
      (() => {
        const r = flatRect(args.collisionRect)
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })()
    // Прямоугольники берутся у dnd-kit (он их уже измерил на старте жеста), а не
    // меряются заново: своё измерение здесь стоило бы прохода по DOM на каждое движение
    // указателя. flatRect обязателен — у ClientRect'ов dnd-kit `top`/`left` не поля, а
    // геттеры со чтением scroll (TD-55).
    const boxes = new Map<string, Box>()
    for (const c of args.droppableContainers) {
      const raw = args.droppableRects.get(c.id)
      if (raw) boxes.set(String(c.id), flatRect(raw))
    }
    const target = pickDropTarget(rows, boxes, point, {
      layer: isGroupDrag ? 'unit' : 'part',
      inner: INNER_ROWS,
      activeId: String(args.active.id),
    })
    targetRef.current = target
    // Ряд для приглашения «встань в ряд» — вопрос ПОД УКАЗАТЕЛЕМ, а не названный целью
    // (2026-08-12). У цели якорь — хвост вопроса, и приглашение, взятое от неё,
    // загоралось только у последней строки: колонку предлагают вопросу целиком, ждать
    // его хвоста незачем. Считает pickHoverGroup — там же и довод, почему двум ответам
    // здесь расходиться нечем.
    nearGroupRef.current = pickHoverGroup(rows, boxes, point, {
      layer: isGroupDrag ? 'unit' : 'part',
      inner: INNER_ROWS,
      activeId: String(args.active.id),
    })
    // `over` У DND-KIT ОБЯЗАН БЫТЬ НЕПУСТЫМ, и это не про его удобство. Без него
    // `useSortable` гасит трансформу активного элемента ЦЕЛИКОМ — `displaceItem`
    // требует валидного `overIndex`, а в `finalTransform` через него проходит и
    // `dragSourceDisplacement`, то есть та самая трансформа, которой элемент едет за
    // курсором. Отдав пустоту, полотно роняет блок обратно в его слот — автор видит это
    // как «блок пропадает из-под указателя». Позиций без цели у полотна две — мёртвая
    // зона на нехвостовой строке вопроса (§5.2) и «встать первым», у которой
    // элемента-адреса нет по определению, — и обе обязаны отдавать что-то живое.
    //
    // Отдаём droppable того, НАД ЧЕМ указатель: это ровно то, что `over` у dnd-kit и
    // значит. Команду и линию полотно берёт из targetRef, поэтому расхождение безвредно
    // — в мёртвой зоне цели по-прежнему нет, дроп там ничего не делает.
    const named =
      target === null || target.afterId === null
        ? null
        : isGroupDrag
          ? (blocks.find((b) => b.id === target.afterId)?.groupId ?? null)
          : target.afterId
    const overId = named ?? idleOverId(nearGroupRef.current, isGroupDrag, String(args.active.id))
    const hit = args.droppableContainers.find((c) => String(c.id) === overId)
    return hit ? [{ id: hit.id, data: { droppableContainer: hit, value: 0 } }] : []
  }

  // Пересчёт кадра драга: гост источника, линия вставки, ближайшее место для приглашения
  // «встань в ряд» и предупреждающая рамка. Состав рамки даёт прогноз planBlockDrop
  // (captionLoss по нему), геометрию — живой DOM по data-block-id. Пустой состав — нет
  // оверлея.
  function updateFrame(activeId: string, sourceIds: string[]) {
    const root = canvasRef.current
    // Ближайшее место и зона под курсором — в состояние тем же кадром, что и оверлеи: по
    // первому полотно решает, у какой группы зажечь приглашение, по второй — какая полоса
    // горит и что исполнит отпускание. setState тем же значением React гасит сам, поэтому
    // в состоянии лежат строки, а не разобранные объекты.
    setNearGroup(nearGroupRef.current)
    setZoneId(zoneRef.current)
    if (!root) return
    // ГОСТ ИСТОЧНИКА — ДО всякой цели: он про место, откуда элемент взяли, и его наличие
    // ни от чего не зависит. Курсор в зоне приглашения (цели нет вовсе) — дыра в потоке
    // никуда не делась, значит и гост остаётся.
    setRect(setSourceGhost, measureSlot(root, sourceIds, BLOCK_ANCHOR, ROW_PAD))
    const target = targetRef.current
    if (!target) {
      setWarnFrame(null)
      setDropLine(null)
      return
    }
    // ЛИНИЯ ВСТАВКИ — единственное, что называет место, и она нужна ОБОИМ слоям: соседи
    // не расступаются, поэтому без неё групповой драг остался бы вовсе без отклика. Что
    // мерить и с какой стороны, полотно больше не выводит само — это сказала цель
    // (dropTarget.ts), и говорящих о месте по-прежнему ровно один.
    setRect(setDropLine, measureLine(root, target.lineIds, target.before, BLOCK_ANCHOR, ROW_GAP))
    // Дальше — рамка, адресованная только БЛОЧНОМУ драгу: вопрос переезжает целиком,
    // ни в чей состав не входит и ничьего заголовка не забирает.
    if (groupIds.has(activeId)) {
      setWarnFrame(null)
      return
    }
    // СОСТАВ рамки зависит только от цели, а меняется она редко — геометрия же обязана
    // пересчитываться каждый кадр (активная строка едет). Поэтому прогноз считается один
    // раз на цель и лежит в ref: planBlockDrop копирует весь документ и выводит groupId,
    // captionLoss идёт по нему ещё раз, и делать это 60 раз в секунду ради неизменного
    // ответа — чистый мусор для сборщика на длинной форме.
    if (planRef.current === null || planRef.current.key !== target.afterId) {
      const plan = planBlockDrop(blocks, activeId, target.afterId)
      planRef.current = {
        key: target.afterId,
        lossIds: plan ? captionLoss(blocks, plan.blocks).map((l) => l.id) : [],
      }
    }
    setRect(setWarnFrame, measureUnion(root, planRef.current.lossIds, BLOCK_ANCHOR))
  }

  function startFrameLoop(activeId: string, sourceIds: string[]) {
    frameArgsRef.current = { activeId, sourceIds }
    cancelAnimationFrame(frameRafRef.current)
    const tick = () => {
      const a = frameArgsRef.current
      if (!a) return
      updateFrame(a.activeId, a.sourceIds)
      frameRafRef.current = requestAnimationFrame(tick)
    }
    frameRafRef.current = requestAnimationFrame(tick)
  }

  function stopFrameLoop() {
    frameArgsRef.current = null
    cancelAnimationFrame(frameRafRef.current)
    setWarnFrame(null)
    setDropLine(null)
    setSourceGhost(null)
    setZoneId(null)
    setNearGroup(null)
    targetRef.current = null
    zoneRef.current = null
    nearGroupRef.current = null
    planRef.current = null
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
    // Цель и зона снимаются ДО остановки цикла: stopFrameLoop гасит обе.
    const target = targetRef.current
    const zone = zoneRef.current
    stopFrameLoop()
    const candidate = rowCandidate
    const cellCand = cellCandidate
    setDrag(null)
    const { active } = e
    // Зона исполняет ту же зону, которую полотно всё это время подсвечивало, — `over` у
    // dnd-kit про неё не знает вовсе (её id не сортируемый, см. состояние зоны).
    if (zone !== null) {
      const zoneTarget = rowZoneTarget(zone)
      if (zoneTarget !== null) {
        if (candidate) {
          captionGuard(() =>
            placeInRow(candidate, zoneTarget.groupId, zoneTarget.col, zoneTarget.insert),
          )
        }
        return
      }
      // Зона второго уровня: ряд внутри вопроса. Заголовка здесь не теряет никто (обе
      // строки остаются в своей группе), но идём через тот же captionGuard — цену
      // структурных команд называет одно место, и исключений у него нет.
      const cellTarget = cellZoneBlock(zone)
      if (cellTarget !== null) {
        const dragged = String(active.id)
        if (cellCand === cellTarget) captionGuard(() => placeBlockInRow(dragged, cellTarget))
        return
      }
    }
    // Вертикальный дроп исполняет ТУ ЖЕ цель, которую всё это время рисовала линия, — не
    // `over`. Иначе показанное и сделанное расходились бы ровно там, где полотно и
    // dnd-kit считают цель по-разному, а считают они её по-разному всегда: у dnd-kit
    // центры, у полотна указатель.
    if (!target) return
    const activeId = String(active.id)
    if (groupIds.has(activeId)) {
      const afterGroup =
        target.afterId === null
          ? null
          : (blocks.find((b) => b.id === target.afterId)?.groupId ?? null)
      captionGuard(() => reorderGroups(activeId, afterGroup, target.column))
    } else {
      captionGuard(() => reorderBlocks(activeId, target.afterId, target.column))
    }
  }

  // Создаёт новую текстовую строку и фокусирует её. Enter (§3.2) кладёт строку ПОСЛЕ
  // всей группы — новый блок не втискивается в текущий вопрос; Shift+Enter (opts.inside)
  // — сразу под текущей строкой, внутри группы (regroup оставит контент в вопросе).
  // Засев первого символа и открытие меню типов — опции с объектной остановки/пустого
  // полотна.
  const startBlock = useCallback(
    (
      afterId: string | null,
      opts: { openMenu?: boolean; seed?: string; inside?: boolean } = {},
    ) => {
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
    },
    [addBlockAfter, addBlockAfterGroup, updateBlock, engine],
  )

  function focusFirstOrCreate() {
    const first = blocks[0]
    if (first) engine.focusBlock(first.id)
    else startBlock(null)
  }

  // Фокус на заголовок формы (его textarea всегда смонтирован над полотном): каретка
  // в конец. Сюда уходит фокус, когда удаляют первую/единственную строку — иначе он
  // потерялся бы в body. rAF не нужен (нет Radix-возврата фокуса).
  const focusTitle = useCallback(() => {
    const title = splitFormTitle(storeApi.getState().blocks).title
    if (title) engine.focusBlock(title.id, 'end')
  }, [storeApi, engine])

  // onAddBelow: новая текстовая строка ниже — Enter (после группы), Shift+Enter
  // (opts.inside — внутрь группы), либо с засевом/меню с объектной остановки (§2.2).
  // Прокидывает opts в startBlock.
  const handleAddBelow = useCallback(
    (id: string, opts?: { openMenu?: boolean; seed?: string; inside?: boolean }) => {
      startBlock(id, opts)
    },
    [startBlock],
  )

  // Кнопка «+»: открыть диалог выбора типа блока (после блока id).
  const handleInsertBelow = useCallback((id: string) => {
    setInsertAfterId(id)
    setInsertOpen(true)
  }, [])

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
  const handleBackspaceAtStart = useCallback((id: string) => {
    const blocks = readBlocks()
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
  }, [readBlocks, removeBlock, removeGroup, changeBlockType, engine, focusTitle])

  // Cmd/Ctrl+Enter (§3.2) — «действие над ответом»: из подписи/контента прыгнуть к
  // контролу ответа своей группы. choice: каретка на последний вариант (edge end), а
  // если вариантов ещё нет — на призрака списка, он же и есть место для набора.
  // На картинке файловый диалог открывает сама объектная остановка (см. ObjectStop).
  const handleAnswerAction = useCallback(
    (id: string) => {
      const blocks = readBlocks()
      const src = blocks.find((b) => b.id === id)
      if (!src) return
      const field = blocks.find((b) => b.groupId === src.groupId && isAnswerableType(b.type))
      if (!field) return
      engine.focusBlock(field.id, 'end')
    },
    [readBlocks, engine],
  )

  // Cmd+Shift+Backspace (§3.4): явное удаление блока — на подписи сносит группу
  // целиком (подпись владеет группой), иначе один блок. Без диалога подтверждения
  // (решение владельца): страховка — тост с напоминанием про Ctrl+Z, а undo
  // восстанавливает группу в целости. Исход фокуса по контракту (§2.4): следующая
  // строка после группы, иначе предыдущая, иначе заголовок формы.
  const handleDeleteBlock = useCallback((id: string) => {
    const blocks = readBlocks()
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
  }, [readBlocks, removeBlock, removeGroup, engine, focusTitle])

  // Backspace на объектной остановке (§2.2/§2.4): удалить объект, каретка — в конец
  // предыдущей строки; её нет → заголовок формы.
  const handleBackspaceDelete = useCallback(
    (id: string) => {
      const blocks = readBlocks()
      const i = blocks.findIndex((b) => b.id === id)
      const prevStop = stopNeighbor(blocks, i, 'up')
      removeBlock(id)
      if (prevStop) engine.focusBlock(prevStop.id, 'end')
      else focusTitle()
    },
    [readBlocks, removeBlock, engine, focusTitle],
  )

  // Обход стрелками между строками (§2.1): вниз — в начало следующей, вверх — в конец
  // предыдущей; из первой строки вверх — заголовок формы. Край определяет, куда встанет
  // каретка у многострочных/составных целей (первый/последний вариант choice).
  // Инпуты плейсхолдера с подписью — листы: поток их перескакивает (stopNeighbor),
  // каретка приземляется на подпись, а не в необязательное поле (navigation.ts).
  const handleArrow = useCallback(
    (id: string, dir: 'up' | 'down') => {
      const blocks = readBlocks()
      const i = blocks.findIndex((b) => b.id === id)
      const neighbor = stopNeighbor(blocks, i, dir)
      if (neighbor) engine.focusBlock(neighbor.id, dir === 'up' ? 'end' : 'start')
      else if (dir === 'up') focusTitle()
    },
    [readBlocks, engine, focusTitle],
  )

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
  const handleRowShift = useCallback(
    (id: string, dir: 'left' | 'right') => {
      const blocks = readBlocks()
      const gid = blocks.find((b) => b.id === id)?.groupId
      if (gid === undefined) return
      // Группы считаются здесь, а не берутся с рендера: обработчик обязан быть
      // стабильной ссылкой (иначе memo строк не срабатывает), а разбиение — чистая
      // функция, и один её прогон на жест ничего не стоит.
      const group = groupBlocks(blocks).find((g) => g.id === gid)
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
    },
    [readBlocks, takeOwnRow, placeBlockInRow, shiftColumn],
  )

  // Что рисует ГОСТ ИСТОЧНИКА: тащат вопрос — его копия целиком, тащат строку — она
  // одна. Копия неизменна весь жест (drag меняется только на старте и конце), поэтому
  // считается мемо, а не в кадре: узел, пересобираемый 60 раз в секунду, ремаунтил бы
  // сам себя вместе со всеми BlockField внутри.
  const sourceGhostNode = useMemo(() => {
    if (drag === null) return null
    if (drag.kind === 'group') {
      const g = groups.find((x) => x.id === drag.activeId)
      return g ? <GhostGroup group={g} /> : null
    }
    const b = blocks.find((x) => x.id === drag.activeId)
    return b ? <GhostBlock block={b} /> : null
  }, [drag, groups, blocks])

  // Ряд, у которого горит приглашение, — РОВНО ОДИН: ближайший к перетаскиваемому
  // элементу (правила и отказы — rowZones.ts, там же их сторож). Адресуется ряд id
  // ПЕРВОЙ своей группы: это и якорь зоны, и цель placeInRow, который сам найдёт ряд
  // цели и доложит элемент в конец нужной колонки.
  // Пока курсор В зоне, приглашение ПРИБИТО к ней: зоны спрашиваются первыми, и ряд
  // под указателем в этих кадрах не пересчитывается вовсе. Иначе, зайдя в зону у края
  // полотна, автор мог бы увести приглашение на соседний ряд — и погасить зону под
  // собственным курсором. Курсор ушёл из зоны — правило снова обычное.
  const inviteRow = useMemo(
    () => hoverZone?.groupId ?? inviteRowId(rows, nearGroup, rowCandidate),
    [hoverZone, rows, nearGroup, rowCandidate],
  )
  // Во время БЛОЧНОГО драга зона своей линии не рисует (заливка остаётся). Довод был в
  // правде: рейл зоны висит на контейнере РЯДА, а тот во время такого жеста менял вид,
  // не меняя своего бокса (внутри появлялся дублёр), и статичная линия обнимала не то,
  // что видит автор — в одной колонке ряда стоит стопка вопросов, и в неё попадают
  // чужие строки. ДОВОД СНЯЛСЯ: измеренный рейл убран 2026-08-11, дублёр — 2026-08-12,
  // ряд неподвижен на обоих слоях. Правило осталось, но держится теперь ни на чём:
  // пересматривать его — с владельцем (§5 EDITOR.md).
  const zoneRailOff = drag?.kind === 'block'
  // Горит ли ЭТА полоса: зона под курсором известна полотну (zoneId), и сравнение идёт
  // по её адресу, а не по `isOver` у dnd-kit — зона больше не его `over`. Совпасть могут
  // только зоны одного ряда: рисуются они лишь у приглашённого.
  const zoneHot = (col: number, insert: boolean): boolean =>
    hoverZone !== null &&
    hoverZone.groupId === inviteRow &&
    hoverZone.col === col &&
    hoverZone.insert === insert

  // Одна группа полотна. Вынесена из JSX функцией, потому что зовут её из двух мест:
  // прямо из ряда-одиночки и из ячейки ряда (стопка групп, §5). railOff — у ряда горят
  // зоны: рейл группы стоит на том же вылете, что и рейл зоны, и две линии в одном
  // жёлобе читались бы как одна размазанная.
  //
  // headOfCell — вопрос открывает стопку колонки и потому интервала перед собой не
  // несёт (его несёт ряд). Позиция приезжает ПРОПОМ, а не вариантом `first:`: в боксе
  // колонки первыми стоят зоны жеста, они появляются с началом драга, и CSS-правило
  // «первый ребёнок» роняло бы вопросу интервал прямо посреди жеста.
  const renderGroup = (
    g: (typeof groups)[number],
    railOff = false,
    headOfCell = false,
  ) => (
    <GroupRow
      key={g.id}
      group={g}
      firstGroup={g.id === groups[0]?.id}
      headOfCell={headOfCell}
      formId={formId}
      blockIds={blockIds}
      // Зона второго уровня: id подписи, у которой горит приглашение собрать ряд
      // внутри вопроса (null — не в этой группе). Ближним рядом не ограничивается:
      // цель здесь ровно одна на всё полотно — подпись СВОЕЙ же группы.
      cellZone={cellCandidate}
      // Горит ли полоса второго уровня: та же схема, что у зон ряда.
      cellHot={cellCandidate !== null && hoverCell === cellCandidate}
      rail={
        drag
          ? drag.kind === 'group' && g.id === drag.overGroup && !railOff
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
  )

  return (
    // Метрики холста = общий .rf-page (fields.css): десктоп 144/80/96, мобильный
    // 40/20/64 — тот же брейкпоинт (sm=640), чтобы редактор не разъезжался с
    // превью/рендерером на узком экране.
    <FocusEngineProvider value={engine}>
      {/* Активная строка (§7): значение и API — разными провайдерами, чтобы строки-
        репортёры не перерисовывались от смены каретки (см. activeRow.ts). */}
      <ActiveRowApiProvider value={activeRow.api}>
        <ActiveRowValueProvider value={activeRow.active}>
          {/* Обложка — во всю ширину полотна, поэтому ВНЕ коробки max-w-[860px]
        (та же граница, что в рендерере: обложка сестра .rf-page). */}
          {/* КОНТЕЙНЕР ТЕМЫ (фаза 22) — здесь, а не глубже: обложка стоит ВНЕ
        коробки колонки, но красится тем же холстом, и переменные обязаны накрывать
        обоих. На :root тему ставить нельзя — она перекрасила бы кабинет вокруг. */}
          <div className={`rf-theme ${designClasses(design)}`} style={designToVars(design)}>
            <CoverArea formId={formId} />
            {/* relative — якорь координат оверлеев драга (updateFrame меряет относительно него).
          Верхний отступ с обложкой поджимается: 144px пустоты над заголовком там уже
          лишние, воздух дала сама обложка. Остаётся 68px (60 мобильный) — внутри этого
          зазора висит кластер кнопок «завести» (AddChrome), absolute и без своей высоты.
          Числа зеркалят .rf-page.rf-covered (fields.css) — правишь там, правь и здесь.
          Утилитой с var() эти два числа НЕ объединять: pt-[var(--rf-cover-gap)] схлопывал
          отступ в ноль (2026-08-15), полотно оставалось без воздуха над заголовком. */}
            {/* Семейство и выравнивание — ЗДЕСЬ, на аналоге .rf-page, а не глубже: у
          превью и рендерера оба свойства объявлены один раз на холсте и наследуются
          вниз (поля и подписи берут font-family: inherit). Полотно холста-класса не
          носит — метрики оно держит своим Tailwind, — поэтому обе строки нужны ему
          отдельно, иначе смена шрифта и выравнивания видна автору только в превью. */}
            <div
              ref={canvasRef}
              className={`relative mx-auto max-w-[calc(var(--rf-column)+10rem)] px-5 pb-16 [font-family:var(--rf-font-family)] [text-align:var(--rf-align)] sm:px-20 sm:pb-24 ${
                cover ? 'pt-15 sm:pt-17' : 'pt-10 sm:pt-36'
              }`}
            >
            {/* Оверлеи ниже — absolute ДО списка в DOM (строки positioned и рисуются
          поверх), позиционирование ПРЯМОЕ, без своей анимации: rAF-замер и так даёт
          гладкие значения, а пружина, ретаргетируемая каждый кадр, копила скорость по
          движущейся цели и отскакивала на остановке. Замер гонит именно rAF, а не
          события драга: onDragMove молчит, пока активная строка доигрывает свой переход,
          и оверлей отставал бы от неё. */}
            {/* ГОСТ ИСТОЧНИКА: копия в слоте, из которого элемент вынули. Геометрия —
          лайаут-бокс слота (measureSlot), а не клиентский прямоугольник: сам элемент в
          это время едет за курсором трансформом. Ширину задаём измеренную, высоту — нет:
          копия рисуется теми же BlockField, что и оригинал, и своя высота у неё честнее
          округлённой чужой. */}
            {sourceGhost && sourceGhostNode && (
              <SourceSlot rect={sourceGhost}>{sourceGhostNode}</SourceSlot>
            )}
            {/* ЛИНИЯ ВСТАВКИ: где элемент окажется, если отпустить сейчас. Соседи с
          2026-08-11 неподвижны (стратегия расступания снята), и место называет только
          она. Ширина линии — часть сообщения: во всю форму значит «между рядами», в
          одну колонку — «в эту колонку». Тот же слой и тот же способ позиционирования,
          что у рейла: absolute-оверлей по измеренным rect'ам, без своей анимации. */}
            {dropLine && <DropLine rect={dropLine} />}
            {/* Рамка-предупреждение (§4.3): строка, которая от этого дропа останется
          без заголовка. Про МЕСТО вставки она, в отличие от рейла, не говорит ничего —
          только про УЩЕРБ: «отсюда уйдёт имя». */}
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
            {/* Логотип — уже ВНУТРИ колонки: выравнивается по её левому краю, как в
          рендерере. */}
            <LogoArea formId={formId} over={Boolean(cover)} />
            {/* group/title — якорь наведения кнопок «завести» (AddChrome): показываются
          только при наведении на заголовок, не на всё полотно. AddChrome стоит внутри
          этой группы, а не снаружи, — иначе наведение на сами кнопки гасило бы их. */}
            <div className="group/title">
              <AddChrome formId={formId} onOpenDesign={onOpenDesign} />
              {formTitle && <FormTitleRow block={formTitle} onEnter={focusFirstOrCreate} />}
            </div>

            {blocks.length === 0 ? (
              <EmptyStarter onStart={(opts) => startBlock(null, opts)} />
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={collisionDetection}
                // Стратегия замера и опции сенсоров — модульные константы (см. MEASURING).
                measuring={MEASURING}
                onDragStart={(e) => {
                  const id = String(e.active.id)
                  const isGroup = groupIds.has(id)
                  setDrag({ kind: isGroup ? 'group' : 'block', activeId: id, overGroup: null })
                  // rAF-цикл ведёт рамки (только блочный драг) И ближайшее место с гостом
                  // источника (оба слоя: вопрос за ручку подписи встаёт в ряд ровно так
                  // же, как одиночка), поэтому запускается всегда. Рамки внутри него сами
                  // выходят на групповом драге — его отклик нативный.
                  //
                  // Слот считается один раз здесь: состав его строк за жест не меняется
                  // (меняется только их место, а его цикл и меряет). Тащат вопрос — слот
                  // это все его строки, тащат строку — она сама.
                  startFrameLoop(
                    id,
                    isGroup ? blocks.filter((b) => b.groupId === id).map((b) => b.id) : [id],
                  )
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
                }}
                onDragEnd={onDragEnd}
                onDragCancel={() => {
                  stopFrameLoop()
                  setDrag(null)
                }}
              >
                <SortableContext items={groupIdList} strategy={canvasSorting}>
                  {/* Ритм полотна = ритм превью/рендерера (этап 13.3). ИНТЕРВАЛ НЕСЁТ САМ
                ЭЛЕМЕНТ — это его ВЕРХНИЙ отступ, «место передо мной», а не gap
                контейнера (2026-08-13, см. .rf-form в fields.css): 28px у ряда
                и у вопроса в колонке = .rf-form, 14px внутри вопроса даёт строка
                (BlockRow). У контейнера остаётся только 64px заголовок
                формы→первый блок = gap .rf-page (48px) + margin-bottom .rf-title
                (16px, добавка сверх ритма — fields.css).
                КАЖДОЕ ЧИСЛО РИТМА УМНОЖЕНО НА --rf-density — тем же множителем, что в
                fields.css: плотность у автора одна на все три поверхности, и литерал
                здесь означал бы полотно, которое за настройкой не едет. Добавка 16px
                от .rf-title множителю не подчиняется — она не интервал ритма.
                py-1.5 строк в вертикаль НЕ входит (там -mb-1.5 и укороченный на
                столько же mt, см. BlockRow), поэтому просвет здесь — чистый контент и
                совпадает с превью замером (критерий 13.3 — ноль расхождений). */}
                  {/* Ряды — НАСТОЯЩИЕ контейнеры (а не flex-wrap с шириной в 50%, как было
                до появления стопок): правая колонка ряда может держать НЕСКОЛЬКО
                групп друг под другом (§5), а wrap уложил бы третью полуширинную li
                в начало новой строки, а не в стопку. Разметка теперь совпадает с
                превью и рендерером один в один: .rf-row → .rf-cell → группы.
                DOM-порядок = порядок документа, sortable-вселенная не тронута —
                обёртки не заводят вложенных SortableContext, только лэйаут. */}
                  <ol className="mt-[calc(3rem*var(--rf-density)_+_1rem)] flex flex-col">
                    {rows.map((row, rowIndex) => {
                      const rowId = row[0]![0]!.id
                      // Приглашение висит на РЯДЕ, а не на группе, и это не косметика:
                      // полоса ряда неподвижна, её края = края холста при любом
                      // содержимом, тогда как край группы зависит от того, что внутри.
                      // Ряд узнаёт себя по СОСТАВУ, а не по адресу: адресом зоны служит
                      // любой участник, кроме перетаскиваемого (см. inviteRowId), тогда
                      // как key ряда обязан оставаться стабильным — иначе смена адреса
                      // посреди драга ремаунтила бы весь ряд.
                      const zones = hasGroup(row, inviteRow)
                      // Колонок в ряду СЕЙЧАС — от этого зависит, какие зоны показывать:
                      // границ на одну больше, чем колонок, а подвал есть у каждой
                      // колонки настоящей секции (у полноширинного ряда колонок нет, и
                      // «в стопку» там значить нечему — placeInRow такой дроп отвергнет).
                      // Границы гаснут на потолке: обещать колонку, которой не будет,
                      // нельзя.
                      const cols = row.length
                      const canAdd = cols < MAX_COLUMNS
                      // ДУБЛЁРА ЗДЕСЬ БОЛЬШЕ НЕТ (решение владельца 2026-08-12). Пока
                      // курсор стоял в зоне, ряд перестраивался в секцию и будущее место
                      // занимала тусклая копия перетаскиваемого — показ результата вместо
                      // отклика. Ушёл он вместе с последней причиной, по которой полотно
                      // во время драга вообще что-то двигало: раскладка теперь неподвижна
                      // целиком, а место называют линия (§5.2) и полоса взятой зоны.
                      const cellNodes = row.map((c, i) => (
                        <div
                          key={c[0]!.id}
                          // self-start — ЯЧЕЙКА ОБНИМАЕТ СВОЁ СОДЕРЖИМОЕ, а не тянется на
                          // высоту ряда. Флексовый `stretch` растягивает короткую колонку
                          // до низа секции, и её подвал — зона «встань в стопку» — уезжает
                          // под ВЕСЬ ряд, за чужую колонку: автор целится под свой
                          // единственный вопрос, а зона этажом ниже. Вида это не меняет
                          // (ячейка ничего не рисует, дети и так лежат сверху), но это
                          // осознанное расхождение с `.rf-cell` рендерера — там растяжение
                          // безвредно, зон нет.
                          // Вертикального зазора у колонки нет: интервал стопки несут сами
                          // вопросы (mt-7 у li в GroupRow), как .rf-cell у превью.
                          className="relative flex min-w-0 flex-1 flex-col self-start"
                        >
                          {/* Зоны колонки живут в ЕЁ боксе: внутренняя граница — в
                              жёлобе слева от неё, подвал — под ней. Первая колонка
                              границы не показывает: слева от неё внешняя полоса, у
                              которой для этого есть поле полотна.
                              Стоят они у ВСЕХ колонок ряда и всегда — иначе несмонтированный
                              droppable нечем поймать. Видно при этом РОВНО ОДНУ, ту, что
                              под курсором: показывается зона не сама по себе, а когда взята
                              (§5.1). */}
                          {zones && i > 0 && i < cols && canAdd && (
                            <GapDropZone
                              id={rowZoneId(inviteRow!, i + 1, true)}
                              hot={zoneHot(i + 1, true)}
                              gutter={ROW_GUTTER}
                            />
                          )}
                          {zones && cols > 1 && i < cols && (
                            <FootDropZone
                              id={rowZoneId(inviteRow!, i + 1, false)}
                              hot={zoneHot(i + 1, false)}
                              gutter={ROW_GUTTER}
                            />
                          )}
                          {c.map((g, gi) => renderGroup(g, zones, gi === 0))}
                        </div>
                      ))
                      return (
                        // Ряд — контейнер ВСЕГДА, даже об одном вопросе: он якорь зон и
                        // единственный бокс, чья геометрия не зависит от того, что внутри.
                        // Мобильный — стек, тот же брейкпоинт (sm=640), что у .rf-row в
                        // fields.css: иначе полколонки остались бы и на телефоне, где у
                        // респондента ряд разваливается.
                        // mt — интервал ПЕРЕД рядом (28px, .rf-form у превью); у первого
                        // ряда его нет, начало полотна задаёт отступ ol от заголовка формы.
                        // gap здесь — зазор между КОЛОНКАМИ (на мобильном ряд
                        // разваливается в стек, и тот же зазор становится вертикальным),
                        // как .rf-row. Оба множатся на --rf-density, как и там.
                        <div
                          key={rowId}
                          className={`relative flex flex-col gap-[calc(1.75rem*var(--rf-density))] sm:flex-row ${
                            rowIndex === 0 ? '' : 'mt-[calc(1.75rem*var(--rf-density))]'
                          }`}
                        >
                          {zones && canAdd && (
                            <SideDropZone
                              id={rowZoneId(inviteRow!, 1, true)}
                              side="left"
                              railOff={zoneRailOff}
                              hot={zoneHot(1, true)}
                            />
                          )}
                          {zones && canAdd && (
                            <SideDropZone
                              id={rowZoneId(inviteRow!, cols + 1, true)}
                              side="right"
                              railOff={zoneRailOff}
                              hot={zoneHot(cols + 1, true)}
                            />
                          )}
                          {cellNodes}
                        </div>
                      )
                    })}
                  </ol>
                </SortableContext>
              </DndContext>
            )}

            {/* Служебный ярус под полотном: вставка блока мышью. Вход в шпаргалку
          отсюда не ведёт — она открывается только аккордом Mod+/ (useGlobalChord). */}
            {blocks.length > 0 && (
              <div className="mt-4 flex items-center text-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={() => handleInsertBelow(blocks[blocks.length - 1]?.id ?? '')}
                  className="text-left hover:text-foreground"
                >
                  + Добавить блок
                </button>
              </div>
            )}

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
          </div>
        </ActiveRowValueProvider>
      </ActiveRowApiProvider>
    </FocusEngineProvider>
  )
}

// «Пусто» считается по ПЛОСКОМУ тексту, а не сравнением поля с пустой строкой: с фазы
// 14 text — массив спанов, и `(text ?? '') === ''` для него ложно ВСЕГДА (пустой массив
// не равен пустой строке). Тип это пропускает — `Span[] | ''` пересекается с `''`,
// поэтому tsc сравнение не запрещает, — и весь жест молча переставал работать: пустая
// строка не схлопывалась ни в какой ситуации.
const isBlank = (b: Block) => plainText(b.text) === ''

// useIdList — список id, чья ССЫЛКА живёт, пока живёт сам список id.
//
// Зависимость useMemo — строка, а не массив-источник: источник (blocks/groups) меняет
// идентичность на каждую правку любого блока, а id при этом остаются прежними.
// JSON.stringify, а не join с разделителем: id — свободная строка по контракту
// (idSchema), и символ, который в неё заведомо не попадёт, пришлось бы выдумывать.
// Цена ключа — обход двухсот коротких строк на рендер, то есть микросекунды против
// десятков миллисекунд, которые стоит протяжка контекста dnd-kit.
function useIdList(items: readonly { id: string }[]): string[] {
  const key = JSON.stringify(items.map((x) => x.id))
  return useMemo(() => JSON.parse(key) as string[], [key])
}

// Опции сенсоров и конфигурация замера — МОДУЛЬНЫЕ КОНСТАНТЫ, а не литералы в теле
// компонента, и это не косметика, а главная находка починки TD-32.
//
// `useSensor` мемоизирует дескриптор по ССЫЛКЕ на объект опций. Литерал в аргументе —
// новый объект на каждый рендер полотна, то есть новый дескриптор, новый массив
// `sensors`, новые `activators` и, в итоге, НОВОЕ ЗНАЧЕНИЕ внутреннего контекста
// DndContext. А его читает каждый `useDraggable`/`useDroppable`, то есть каждая строка
// и каждая группа полотна.
//
// Смена значения контекста перерисовывает потребителей МИМО memo: React сверяет пропсы,
// но, увидев отложенное обновление контекста, всё равно рендерит. Литерал на этом месте
// гасит memo строки на каждом нажатии клавиши; в CPU-профиле это видно как
// propagateContextChange — самая дорогая функция самотайма.
const POINTER_OPTIONS = { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }
const KEYBOARD_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates }
// СТРАТЕГИЯ ЗАМЕРА: WhileDragging, а не Always (TD-55).
//
// Отличаются стратегии ровно одним, и это вне драга: `isDisabled()` в
// useDroppableMeasuring отдаёт для Always всегда false, а для WhileDragging —
// `!dragging`. Во время жеста обе меряют одинаково, поэтому опасение «померим один раз
// на старте» к WhileDragging не относится.
//
// Чего стоит Always: droppableRects пересобирается на КАЖДОЙ структурной правке в покое,
// а это один синхронный getBoundingClientRect на каждый droppable полотна. Один `Enter`
// на форме из 199 блоков — 301 обращение против нуля; столько же стоят удаление строки
// и `Mod+Alt+→`.
const MEASURING = { droppable: { strategy: MeasuringStrategy.WhileDragging } }

// ЧЕМ ЭТОТ СЛОЙ ОТЛИЧАЕТСЯ ОТ СЛОЯ ВАРИАНТОВ: якорь замера и два числа ритма. Вид жеста
// у них общий (dragChrome.tsx), правила — свои.
//
// ROW_PAD — та же плата, что была у снятого измеренного рейла: бокс строки включает её
// py-1.5, а копия рисуется от текста. Без вычета гост сидел бы на 6px выше дыры.
// Меняешь py-1.5 у строки — правь это число.
// ROW_GAP — половина просвета между вопросами (28px, .rf-form): линия встаёт ровно
// посередине между соседями.
const BLOCK_ANCHOR = 'data-block-id'
// Внутренние ряды вопроса для прицела (PickOpts.inner): «подпись | поле», тот же
// раскладчик, что рисует их у превью. МОДУЛЬНАЯ константа, а не литерал в кадре: прицел
// зовётся на каждое движение указателя, а свежая замыкающая функция каждый кадр — мусор
// на длинной форме (§5.3).
const INNER_ROWS = (blocks: Block[]) => packGroupRows(blocks).map((r) => r.flat())
const ROW_PAD = 6
const ROW_GAP = 7
// Жёлоб между колонками ряда вопросов (gap-7 у контейнера ряда).
const ROW_GUTTER = 28

// hasGroup — состоит ли ряд из этой группы. Ряд узнаётся по СОСТАВУ, а не по адресу
// (§5.1): адресом ряда служит любой его участник, кроме перетаскиваемого, и адрес
// посреди жеста меняется.
type GroupRef = { id: string }
function hasGroup(row: GroupRef[][], id: string | null): boolean {
  return id !== null && row.some((c) => c.some((g) => g.id === id))
}

// Зоны жеста ряда — третий вид droppable'а, помимо групп и строк. Отдельное
// пространство id (префикс), чтобы фильтр коллизий по слоям их не путал ни с
// groupId, ни с block-id.
const ROW_ZONE = 'rowzone:'
// Адрес ряда — id его ПЕРВОЙ группы (зона висит на ряде, а не на группе; см.
// SideDropZone). Для placeInRow это обычная цель: команда сама находит ряд цели,
// поэтому какой именно участник ряда назван адресом, ей безразлично.
//
// ГЕОМЕТРИЯ ЗОНЫ НАЗЫВАЕТ КОМАНДУ, и в этом весь смысл двух её видов (2026-08-10):
// вертикальная полоса на ГРАНИЦЕ колонок открывает новую колонку (insert), полоса в
// ПОДВАЛЕ колонки кладёт элемент в её стопку. Пока колонок было две, обе команды делила
// одна полоса у края ряда, и «в стопку» она означала просто потому, что третьей колонке
// было неоткуда взяться; при четырёх колонках это уже два разных места.
export type RowZone = { groupId: string; col: number; insert: boolean }
const rowZoneId = (rowId: string, col: number, insert: boolean) =>
  `${ROW_ZONE}${insert ? 'b' : 'c'}${col}:${rowId}`
const rowZoneTarget = (id: string | number): RowZone | null => {
  const s = String(id)
  if (!s.startsWith(ROW_ZONE)) return null
  const rest = s.slice(ROW_ZONE.length)
  const at = rest.indexOf(':')
  return { insert: rest[0] === 'b', col: Number(rest.slice(1, at)), groupId: rest.slice(at + 1) }
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

// Копия ВОПРОСА (жест между вопросами): все строки группы, тем же раскладчиком
// внутренних рядов, что у превью.
function GhostGroup({ group }: { group: { id: string; blocks: Block[] } }) {
  const meta = groupMeta(group.blocks).get(group.id)
  return (
    <GhostFrame>
      <div className="rf-group">
        {group.blocks.map((b) => (
          <BlockField
            key={b.id}
            block={b}
            captionText={meta?.caption}
            captionRequired={meta?.required}
          />
        ))}
      </div>
    </GhostFrame>
  )
}

// Копия ОДНОГО блока (жест внутри вопроса): в ряд с подписью уезжает строка ответа.
function GhostBlock({ block, caption }: { block: Block; caption?: string }) {
  return (
    <GhostFrame>
      <BlockField block={block} captionText={caption} />
    </GhostFrame>
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
// (глобальные индексы → перенос через границы групп; см. коммент у blockIds
// в SlashEditor). Отклик блочного драга над группой — линия вставки и оверлеи полотна;
// GroupRow своей подсветки не несёт.
type GroupRowProps = {
  group: { id: string; blocks: Block[] }
  // Первая группа полотна: её первая строка — начало формы, у пустого текста там
  // свой плейсхолдер (§7).
  firstGroup: boolean
  // Вопрос открывает стопку своей колонки: интервала перед собой не несёт, расстояние
  // до предыдущего ряда держит сам ряд.
  headOfCell: boolean
  formId: string
  blockIds: string[]
  // Зона жеста «встань в колонку ряда» здесь НЕ живёт: её якорь — контейнер ряда
  // (SlashEditor), чья геометрия не зависит от содержимого. Здесь остаётся только
  // второй уровень.
  // Второй уровень (§6.6): id ПОДПИСИ, у которой горит приглашение собрать ряд ВНУТРИ
  // вопроса. Не из этой группы или null — зоны нет.
  cellZone: string | null
  // Горит ли полоса второго уровня (курсор в ней). Приезжает пропом, а не спрашивается
  // у dnd-kit: зона не его `over` (см. состояние зоны в полотне).
  cellHot: boolean
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
}

// sameGroupProps — сравнение пропсов группы для memo (TD-32).
//
// Своё, а не поверхностное по ссылке, ровно из-за двух пропсов: `group` пересобирается
// раскладчиком (groupBlocks — чистая функция, новый объект на каждый вызов) и
// `blockIds` пересобирается полотном, а вызываются оба на каждый ре-рендер полотна, то
// есть на каждый введённый символ. По ссылке memo не срабатывал бы НИ РАЗУ.
//
// Оба сравниваются ПОЭЛЕМЕНТНО, и этого достаточно: блоки иммутабельны (updateBlock
// заменяет один элемент массива, не трогая соседей), а id — строки. Остальные пропсы
// сравниваются по ссылке, как в обычном memo: колбэки стабилизированы в полотне
// (useCallback), примитивы сравниваются значением.
function sameGroupProps(a: GroupRowProps, b: GroupRowProps): boolean {
  if (a.group !== b.group) {
    if (a.group.id !== b.group.id) return false
    const x = a.group.blocks
    const y = b.group.blocks
    if (x.length !== y.length || !x.every((v, i) => v === y[i])) return false
  }
  if (a.blockIds !== b.blockIds) {
    if (a.blockIds.length !== b.blockIds.length) return false
    if (!a.blockIds.every((v, i) => v === b.blockIds[i])) return false
  }
  return BY_REFERENCE.every((k) => a[k] === b[k])
}

// Пропсы, которые компаратор сравнивает ПО ССЫЛКЕ, — списком, а не цепочкой `&&`.
//
// Тип здесь — сторож, а не украшение: `Record<Exclude<keyof GroupRowProps, ...>, true>`
// требует перечислить КАЖДЫЙ пропс, кроме двух поэлементных, поэтому новый пропс у
// GroupRow не скомпилируется, пока его сюда не внесли. Без этого отказ был бы
// молчаливым — ровно тем, ради которого вся эта ветка и затевалась: пропс, забытый в
// компараторе, не даёт ни ошибки, ни предупреждения, а группа просто перестаёт
// обновляться (или, наоборот, memo перестаёт срабатывать).
const BY_REFERENCE = Object.keys({
  firstGroup: true,
  headOfCell: true,
  formId: true,
  cellZone: true,
  cellHot: true,
  rail: true,
  menuForId: true,
  onAddBelow: true,
  onInsertBelow: true,
  onBackspaceAtStart: true,
  onBackspaceDelete: true,
  onDeleteBlock: true,
  onAnswerAction: true,
  onArrow: true,
  onRowShift: true,
} satisfies Record<Exclude<keyof GroupRowProps, 'group' | 'blockIds'>, true>) as Exclude<
  keyof GroupRowProps,
  'group' | 'blockIds'
>[]

const GroupRow = memo(function GroupRow({
  group,
  firstGroup,
  headOfCell,
  formId,
  blockIds,
  cellZone,
  cellHot,
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
}: GroupRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isSorting } =
    useSortable({
      id: group.id,
      // Без «доигрывания» анимации после дропа (отскок к старой позиции) — см. dnd.ts.
      animateLayoutChanges: noLayoutAnimation,
    })
  // Translate-only (как у BlockRow): сдвиг без scaleY, чтобы группа не сжималась
  // под высоту соседнего слота при перетаскивании.
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    ...(isDragging ? DRAGGED_FADE : null),
  }
  // Ручка группы, отдаваемая строке подписи, — стабильный объект. Литерал
  // `{ attributes, listeners }` пересоздавался на каждый рендер группы и в одиночку
  // отменял memo у подписи: одна такая строка на вопрос — это половина строк формы.
  const groupHandle = useMemo(() => ({ attributes, listeners }), [attributes, listeners])
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
      // Ширину группа себе НЕ считает: полколонки задаёт ячейка ряда (см. ol в
      // SlashEditor), как .rf-cell у превью. Своя ширина на самой li ломает стопку в
      // колонке — третья полуширинная уезжает на новую строку вместо стопки.
      // ПОКА ИДЁТ ЛЮБОЙ ЖЕСТ, чужие вопросы не отвечают на наведение (решение владельца
      // 2026-08-12): курсор с блоком в руке проезжает по всему полотну, и кластеры
      // значков зажигались у каждой строки, над которой он прошёл. Наведение сейчас
      // значит «тащу над этим», а не «хочу это править». Гасится на ГРУППЕ, а не на
      // строке: строка не знает, что тащат её же вопрос. Перетаскиваемой строке
      // наведение возвращает pointer-events-auto (BlockRow) — ей нужен курсор grabbing.
      // mt — интервал ПЕРЕД вопросом (28px × --rf-density, .rf-form/.rf-cell у превью): он разводит
      // стопку в колонке ряда, а у вопроса, открывающего колонку, его нет — там
      // расстояние держит сам ряд. ОТСТУП, А НЕ ПАДДИНГ: рект li мерят оверлеи жеста,
      // и паддинг увёл бы рейл группы вместе с линией вставки.
      className={`group/grp relative w-full rounded-md ${
        headOfCell ? '' : 'mt-[calc(1.75rem*var(--rf-density))]'
      } ${
        isDragging ? `z-10 ${DRAGGED_LOOK}` : isSorting ? 'pointer-events-none' : ''
      }`}
    >
      {/* Рейл — постоянная идентичность группы (§4.3): тонкая линия в левом
          жёлобе, в покое проявляется по hover/focus-within всей группы; во время
          драга режимом управляет полотно (проп rail — см. SlashEditor). Absolute и
          вне потока (урок TD-22). Кластер значков строки стоит вплотную к
          тексту (mr-1 в BlockRow) и рейл собой закрывает — разойтись им негде, рейл
          лежит между кластером и текстом; видно это только под наведением. top/bottom-0 = ровно высота текста группы:
          -my-1.5 строк компенсирует их py-1.5, li обнимает чистый контент.
          СЛЕВА ВСЕГДА, в любой колонке (2026-08-11): зеркалить рейл вправо было
          осмысленно, пока колонок было две, — при четырёх у средних колонок «своей»
          стороны нет, и одинаковое место читается лучше, чем угадываемое. */}
      {/* БОЛЬШЕ ДВУХ БЛОКОВ, а не больше одного (решение владельца 2026-08-16): у пары
          «подпись + поле» границы вопроса и так очевидны — две строки, и обе на виду.
          Линия там объясняла то, что не требует объяснения. */}
      {group.blocks.length > 2 && rail !== 'off' && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute top-0 bottom-0 -left-2 w-0.5 rounded-full bg-primary/40 ${
            rail === 'on'
              ? ''
              : 'opacity-0 transition-opacity group-hover/grp:opacity-100 group-focus-within/grp:opacity-100'
          }`}
        />
      )}
      {/* Зона второго уровня — «встань в ряд со своей подписью». Якорь ей даёт li, а не
          строка подписи: ширина подписи зависит от того, собран ли ряд, и зона,
          привязанная к её краю, уехала бы из-под курсора. Сторона всегда правая — пара внутри вопроса
          направленная (слева подпись, справа поле), и вопрос, стоящий в секции, зону не
          показывает вовсе (cellCandidate): снаружи него нет поля полотна. */}
      {cellZone !== null && group.blocks.some((b) => b.id === cellZone) && (
        <CellDropZone id={cellZoneId(cellZone)} hot={cellHot} />
      )}
      {/* Стратегия своя (dnd.ts): родная verticalListSortingStrategy считает полотно
          одной вертикалью и на секции сажает строку на строку. */}
      <SortableContext items={blockIds} strategy={canvasSorting}>
        {/* Внутри вопроса блоки стоят теснее — 14px, как .rf-group у превью. Интервал
            несёт САМА СТРОКА (mt у BlockRow), поэтому зазора у колонки нет: у первой
            строки вопроса интервала нет, и li обнимает чистый контент — от этого
            зависит рейл группы (top-0 bottom-0). */}
        <div className="flex flex-col">
          {/* Второй уровень рядов (фаза 15, §6.4/§6.7): пара «подпись | поле» встаёт
              бок о бок. Раскладчик тот же, что у превью и рендерера (packGroupRows),
              и вид тот же: зазор 14px × --rf-density (= .rf-group) и выравнивание по центру
              (items-center = align-items у .rf-group > .rf-row). Ряд из одного
              остаётся прямой строкой колонки — лишняя обёртка сместила бы кластеры. */}
          {packGroupRows(group.blocks).map((innerRow, ri) => {
            // Кто в вопросе ПЕРВЫЙ — знает только раскладчик группы, и знание это
            // позиционное: интервал перед собой несёт строка, а первой его нести
            // незачем — расстояние до предыдущего вопроса держит сам вопрос (mt-7 у li).
            // Внутри вопроса стопки не бывает (пара — «подпись + поле», а отвечаемый
            // блок в группе один), поэтому ячейка здесь всегда об одном блоке.
            const render = (b: Block) => {
              const i = group.blocks.indexOf(b)
              return (
                <BlockRow
                  key={b.id}
                  block={b}
                  formId={formId}
                  firstInGroup={ri === 0}
                  groupHandle={group.blocks.length > 1 && i === 0 ? groupHandle : null}
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
            const pair = innerRow.length > 1
            // Обёртки стоят ВСЕГДА и в одиночном ряду схлопнуты в display:contents —
            // строка остаётся прямым flex-ребёнком колонки, как и была (лишний бокс
            // сместил бы кластеры значков). Урок, оплаченный снятым дублёром второго
            // уровня: менять здесь можно className, но не ТИП узла — тернарник
            // «строка ↔ div» ремаунтил подпись прямо посреди драга, а с ней и её эффекты
            // монтирования (у вопроса, рождённого через «/», заново раскрывалось
            // слеш-меню, openMenuOnMount).
            return (
              <div
                key={innerRow[0]![0]!.id}
                className={
                  pair
                    ? 'flex items-center gap-[calc(0.875rem*var(--rf-density))]'
                    : 'contents'
                }
              >
                {innerRow.map((cell) => (
                  // min-w-0 обязателен, как у .rf-cell: без него длинная подпись не
                  // даёт колонке ужаться и ломает 50/50.
                  <div key={cell[0]!.id} className={pair ? 'min-w-0 flex-1' : 'contents'}>
                    {cell.map(render)}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </SortableContext>
    </li>
  )
}, sameGroupProps)

// SubmitButtonEditor — кнопка отправки формы (всегда видна). Клик открывает поповер
// со сменой её текста; пусто → показывается дефолт. Пишет в стор (форма-уровень),
// автосейв сохраняет вместе со схемой.
function SubmitButtonEditor() {
  const submitLabel = useBuilderStore((s) => s.submitLabel)
  const setSubmitLabel = useBuilderStore((s) => s.setSubmitLabel)
  const label = submitLabel.trim() || DEFAULT_SUBMIT_LABEL

  return (
    // 48px × --rf-density форма→кнопка отправки = gap .rf-page у превью/рендерера
    // (этап 13.3; множитель плотности — фаза 22).
    // .rf-nav — ТА ЖЕ коробка, что у превью и рендерера (фаза 22): положение кнопки
    // задаётся justify-content ряда, и без общей коробки настройка работала бы на
    // двух поверхностях из трёх. Ряд из одного элемента ничего не портит.
    <div className="mt-[calc(3rem*var(--rf-density))] rf-nav">
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
      // Отступ от заголовка формы тот же, что у списка блоков (см. ol выше): приглашение
      // стоит на месте первого вопроса и обязано стоять ровно там, где он появится.
      className="mt-[calc(3rem*var(--rf-density)_+_1rem)] cursor-text text-base leading-6 text-muted-foreground/60 outline-none"
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
