import {
  memo,
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
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Asterisk, Copy, GripVertical, Plus, Trash2 } from 'lucide-react'
import {
  type Block,
  isAnswerableType,
  MAX_COLUMNS,
  isCaptionType,
  isSingleChoiceType,
  isContentType,
  plainText,
  supportsPlaceholder,
  type Span,
} from '@entities/formSchema'
import { optionKey } from '@fields/answer'
import { optionRowWidths, packOptionRows } from '@fields/groups'
import { filterMenuItems, type MenuItem } from './blockTypes'
import { ColumnResizer } from './ColumnResizer'
import { type FormIdSource } from './mediaUpload'
import { rowFacts, textIsBold } from './kinds/index'
import { FIELD_CLS, FieldWrap } from './kinds/fieldWrap'
import {
  canvasSorting,
  DRAG_ACTIVATION_DISTANCE,
  DRAGGED_FADE,
  DRAGGED_LOOK,
  flatRect,
  noLayoutAnimation,
} from './dnd'
import {
  DropLine,
  FootDropZone,
  GapDropZone,
  GhostFrame,
  SideDropZone,
  SourceSlot,
} from './dragChrome'
import { measureLine, measureSlot, type Rect, setRect } from './dragMeasure'
import { type Box, type DropTarget } from './dropTarget'
import {
  inviteOptionRowId,
  optionUnits,
  optionZoneId,
  optionZoneTarget,
  pickHoverOption,
  pickOptionTarget,
} from './optionDrop'
import { useBuilderStore } from './storeContext'
import type { UpdateKind } from './store'
import { useFocusEngine, useRegisterFocusTarget } from './focusEngine'
import { useCaptionGuard } from './captionGuard'
import { textCaret } from './caret'
import { RichLine } from './RichLine'
import { richCaret } from './richCaret'
import { BOLD_MARKS, cutRange } from './richText'
import { SlashMenu } from './SlashMenu'
import { BlockActionMenu } from './BlockActionMenu'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { chords } from './shortcuts'
import { handleRowKeys, type ArrowDir } from './rowKeys'
import { useActiveRow, useRowFocus } from './activeRow'
import { CaptionChip } from './CaptionChip'

export interface BlockRowProps {
  block: Block
  // formId нужен image-блоку для загрузки картинки (POST /forms/{id}/media).
  formId: FormIdSource
  // firstInGroup — строка первая в своём вопросе, и потому интервала перед собой не
  // несёт: расстояние до предыдущего вопроса держит сам вопрос (mt у li группы).
  // Позиция, а не свойство строки, — знает её только раскладчик группы (GroupRow).
  firstInGroup?: boolean
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
//
// СТРОКА РАСЩЕПЛЕНА НА ДВОЕ ради задержки старта драга (TD-55). Здесь — ТОНКАЯ
// ОБОЛОЧКА: `useSortable`, корневой узел с его трансформом и кластер значков, которому
// нужны ручка и слушатели драга. Всё содержимое — в `BlockRowBody` под `memo`, и он про
// dnd не знает вовсе.
//
// Зачем: `useSortable` подписывает строку на контексты dnd-kit, а смена значения
// контекста перерисовывает потребителя МИМО `memo` — React сверяет пропсы, но, увидев
// отложенное обновление контекста, всё равно рендерит. Без разреза любое движение dnd
// перерисовывает все триста строк формы целиком: на форме из 199 блоков старт жеста
// стоил четырёх полных перерисовок полотна, ~180 мс JS.
//
// После разреза контекст перерисовывает только оболочки — а тело бэйлится по пропсам.
// **Условие, без которого разрез не работает:** пропсы тела обязаны быть стабильными
// по ссылке. Их раздаёт полотно (`SlashEditor`: `useCallback`, `useIdList`), а
// `actionOpen`/`setActionOpen` держит оболочка. Уберёшь стабилизацию хоть у одного —
// `memo` перестанет срабатывать МОЛЧА и цена вернётся целиком; сторож — замер
// `e2e/perf` (окно «СТАРТ ЖЕСТА») и `canvasRerender.test.tsx`.
export const BlockRow = memo(function BlockRow(props: BlockRowProps) {
  const { block, groupHandle, requiredFor, needsCaption = false, firstInGroup = false } = props
  const engine = useFocusEngine()
  const captionGuard = useCaptionGuard(engine)
  const removeBlock = useBuilderStore((s) => s.removeBlock)
  const removeGroup = useBuilderStore((s) => s.removeGroup)
  const addCaptionFor = useBuilderStore((s) => s.addCaptionFor)
  // Меню действий живёт в ТЕЛЕ, а открывают его из обоих половин: кликом по грипу
  // (здесь) и аккордом Cmd+. с текстовой поверхности (там). Поэтому состояние держит
  // оболочка и отдаёт телу — сеттер `useState` стабилен по построению, и `memo` тела
  // от него не страдает.
  const [actionOpen, setActionOpen] = useState(false)
  // Точка нажатия на грип: по ней клик-настройки отличается от хвостового click'а
  // после перетаскивания (см. обработчик грипа ниже).
  const gripDownRef = useRef<{ x: number; y: number } | null>(null)

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
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    ...(isDragging ? DRAGGED_FADE : null),
  }

  // Слушатели драга грипа: у подписи мульти-группы — групповые (тащится вопрос
  // целиком), у всех остальных — свои. Одна переменная на оба случая, потому что грип
  // обязан и спредить их, и звать onPointerDown руками (см. кластер значков ниже).
  const dragListeners = groupHandle ? groupHandle.listeners : listeners

  const row = rowFacts(block.type)
  // Высота кластеров значков = высота ПЕРВОЙ строки блока (объявлена типом, fields.css —
  // источник самих чисел). Кластеры absolute и центрируют значок по своей высоте, поэтому
  // только так они стоят на уровне того, чем строка правится: у текстовой строки это
  // line-height (28px у вопроса и заголовка раздела, 24px у остального), у строки с
  // КОНТРОЛОМ — --rf-control-h (36px). Разница видна сразу: с высотой текста кластер у
  // поля вставал на 6px выше его середины (высота поля 36 = 6 паддинга + 24 строка + 6).
  const rowLineH = row?.lineH ?? 'h-6'

  // Кластер значков строки ВЫБОРА снят (решение владельца, ADR §10). Управление списком
  // живёт у карточек вариантов (у каждой свой кластер и свой попап), а самой строкой — у
  // вопроса: подпись и есть её ручка, оттуда же попап меняет тип ответа и сносит вопрос.
  // Так у списка нет двух этажей управления, различающихся парой пикселей, а строка
  // выбора не покидает свой вопрос ни мышью, ни с клавиатуры (TD-44).
  //
  // Условие про подпись обязательно: строка выбора БЕЗ подписи — сама себе вопрос (§4.2:
  // субъект настроек голой строки — она сама), и снятый кластер оставил бы её без
  // единого способа управления мышью. Наличие подписи для строки и означает
  // requiredFor === undefined (звёздочку показывает подпись), поэтому спрашиваем ровно
  // это, а не заводим второй проп о составе группы.
  const ownedByQuestion = row?.surface === 'choice' && requiredFor?.id !== block.id

  // Дать голой строке ответа заголовок (§4.4 спеки фазы 15) — одно действие на два
  // входа: клавиша строки (здесь, на корне) и клик по чипу (в теле). Ссылка стабильна:
  // иначе чип ломал бы memo тела на каждой перерисовке оболочки.
  const addCaption = useCallback(() => {
    const id = addCaptionFor(block.id)
    if (id) engine.focusBlock(id, 'end')
  }, [addCaptionFor, engine, block.id])

  function onRowKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Строке с заголовком жест не обещан (чипа нет) — и не делается: no-op без шага
    // истории, а не тихое «ничего не произошло» после коммита.
    if (!needsCaption || !chords.addCaption(e)) return
    e.preventDefault()
    addCaption()
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      // data-block-id — якорь для замера строки оверлеями драга (updateFrame в
      // SlashEditor): getBoundingClientRect по нему учитывает live-трансформы.
      data-block-id={block.id}
      // py-1.5 — вертикальная hover-зона строки (место под absolute-значки), но в
      // поток она НЕ входит: отрицательные отступы гасят её ровно на padding, поэтому
      // просвет остаётся чистым контентом и совпадает с превью (ритм 13.3). Значки
      // центрируются по top-1.5 = padding → на первой строке текста. Меняешь padding —
      // правь отступы И top-1.5 значков.
      //
      // ИНТЕРВАЛ ПЕРЕД СТРОКОЙ — её собственный ВЕРХНИЙ отступ (12px внутри вопроса,
      // см. .rf-group в fields.css), а не gap контейнера: интервал принадлежит блоку и
      // может быть задан ему отдельно. Из двенадцати вычитается 6px — их уже отдал
      // padding предыдущей строки, то же вычитание, что у -mb-1.5 снизу; сами 12px
      // множатся на --rf-density (плотность автора, фаза 22), вычет 6px — нет: он
      // компенсирует padding, а padding за плотностью не едет.
      // Первая строка вопроса интервала не несёт (его несёт сам вопрос), и её -mt-1.5
      // оставляет li обнимать чистый контент — на это опирается рейл группы.
      // Mod+Alt+T слушает СТРОКА, а не каждая её поверхность: жест относится ко всей
      // строке (дать ей заголовок), а поверхностей у неё несколько — инпут
      // плейсхолдера, объектная остановка, инпуты вариантов. Событие всплывает от
      // любой из них, и ни одна этот аккорд не перехватывает.
      onKeyDown={onRowKeyDown}
      // pointer-events-auto возвращает наведение ТОЛЬКО перетаскиваемой строке: её
      // группа во время чужого жеста погашена (GroupRow), иначе грип под курсором
      // перестал бы быть целью попадания и курсор потерял бы вид «grabbing».
      className={`group relative rounded-md py-1.5 -mb-1.5 ${
        firstInGroup ? '-mt-1.5' : 'mt-[calc(0.75rem*var(--rf-density)_-_0.375rem)]'
      } ${isDragging ? `z-10 pointer-events-auto ${DRAGGED_LOOK}` : ''}`}
    >
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
          обработчик кнопки не срабатывает. Так «+ Описание», стоявшее в потоке под
          заголовком, съедало первый клик по кнопке вставки под полотном — TD-22
          (оба контрола сняты, правило осталось).
          Любой новый reveal-on-hover контрол блока — только сюда.

          Кластер живёт в ОБОЛОЧКЕ, а не в теле: грипу нужны attributes/listeners
          от useSortable, то есть ровно то, что меняет идентичность вместе с контекстом
          dnd. Отдай их телу — и memo на нём перестанет срабатывать (см. шапку). */}
      {/* tabIndex=-1 у значков строки: полотно — один Tab-stop, кнопки-значки —
          мышиные удобства и выпадают из Tab-обхода (§3.1). Клавиатурные эквиваленты —
          шорткаты (Alt+↑/↓ — перенос) и меню действий Cmd+. (13.2).

          Кластер есть у КАЖДОЙ строки, включая строку ответа в собранном вопросе
          (фаза 15, §4.1 спеки): удалить поле отдельно, вставить блок между подписью
          и полем, утащить поле из своего вопроса — законные действия, а не «действия,
          которых не бывает», как считал снятый замок. У вариантов choice поверх этого
          свои кластеры (см. OptionCard). */}
      {!ownedByQuestion && (
        <div
          // mr-1 (решение владельца 2026-08-16): кластер стоит вплотную к своему блоку.
          // Прежние 10px держали дистанцию от рейла группы (-left-2, GroupRow) — теперь
          // жёлоб уже рейла, и у группы из трёх и более блоков наведённая строка
          // накрывает линию своей подложкой (CLUSTER_BACKDROP). Разойтись им негде:
          // рейл лежит МЕЖДУ кластером и текстом, и любое сближение его закрывает.
          // СЛЕВА ВСЕГДА (2026-08-11): прежде у правой колонки ряда кластер зеркалился
          // вправо, потому что слева от неё жёлоб и сосед. При четырёх колонках
          // зеркалить некуда — у средней колонки обе стороны чужие, — и вместо выбора
          // стороны кластер получил подложку (CLUSTER_BACKDROP) и слой поверх соседа.
          //
          // МИНА: погашенный кластер обязан быть ПРОЗРАЧЕН ДЛЯ УКАЗАТЕЛЯ. Он лежит вне
          // бокса строки (right-full), но остаётся её потомком, поэтому наведение на
          // ЕГО площадь — это group-hover строки: без pointer-events-none кластер
          // зажигает сам себя, стоит курсору попасть в левое поле, где его ещё нет.
          // Кроме вранья («навёлся на пустое место — появились чужие значки») это
          // отбирает жёлоб у ручки ширины: 72px кластера шире 12px жёлоба.
          // Показанный — снова ловит события: иначе по его кнопкам нельзя нажать, а
          // hover, ушедший со строки на кластер, гасил бы его под курсором.
          className={`${CLUSTER_BACKDROP} pointer-events-none absolute top-1.5 right-full mr-1 flex ${rowLineH} items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100`}
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
            onClick={() => props.onInsertBelow(block.id)}
            aria-label="Добавить блок ниже (выбрать тип)"
            className={ICON_BTN}
          >
            <Plus className="size-4" />
          </button>
          <button
            type="button"
            {...(groupHandle ? groupHandle.attributes : attributes)}
            {...dragListeners}
            // После спреда: dnd-kit кладёт в attributes свой tabIndex=0 — перебиваем на
            // -1, чтобы грип выпал из Tab (перенос с клавиатуры — Alt+↑/↓, не Space-драг).
            tabIndex={-1}
            // Грип — два жеста на одной ручке (§4.1 спеки фазы 16): тащим — перенос,
            // кликаем — настройки. Имя называет КЛИК: перетаскивание скринридеру и так
            // недоступно (Tab сюда не заходит, перенос с клавиатуры — Alt+↑/↓), а
            // подсказка про оба жеста живёт в title, который видит мышь.
            aria-label={
              groupHandle && isCaptionType(block.type) ? 'Настройки вопроса' : 'Настройки блока'
            }
            title="Настройки — клик, перенос — перетаскивание"
            // ВАЖНО: свой onPointerDown стоит ПОСЛЕ спреда listeners, а значит перебивает
            // одноимённый обработчик dnd-kit — именно им сенсор начинает драг. Поэтому
            // вызываем его руками; забыть этот вызов = грип перестаёт таскать, и молча:
            // ни типы, ни тесты про клик этого не видят.
            onPointerDown={(e) => {
              gripDownRef.current = { x: e.clientX, y: e.clientY }
              dragListeners?.onPointerDown?.(e)
            }}
            onClick={(e) => {
              // Хвостовой click после настоящего драга: браузер шлёт его по mouseup,
              // и без этой проверки попап открывался бы после КАЖДОГО перетаскивания.
              // Отличаем по тому же порогу, по которому сенсор решает «это драг»
              // (DRAG_ACTIVATION_DISTANCE) — иначе два числа разъедутся и меню начнёт
              // выскакивать «иногда».
              const from = gripDownRef.current
              gripDownRef.current = null
              // Строго БОЛЬШЕ, как у сенсора dnd-kit (hasExceededDistance сравнивает
              // через >): при >= жест ровно на пороге пропадал бы молча — сенсор драг
              // не начал, а guard уже съел клик.
              if (
                from &&
                Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_ACTIVATION_DISTANCE
              )
                return
              setActionOpen(true)
            }}
            className={`${ICON_BTN} cursor-grab active:cursor-grabbing`}
          >
            <GripVertical className="size-4" />
          </button>
        </div>
      )}

      <BlockRowBody
        {...props}
        actionOpen={actionOpen}
        setActionOpen={setActionOpen}
        onAddCaption={addCaption}
      />
    </div>
  )
})

const ICON_BTN =
  'flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground'

// CLUSTER_BACKDROP — подложка под кластером значков: непрозрачный прямоугольник в цвет
// ХОЛСТА ФОРМЫ и слой поверх соседей.
//
// Нужен обоим соседям кластера, и по разным причинам. Слева от колонки может стоять
// чужая колонка: кластер висит absolute вне потока, а сосед — обычный элемент дальше по
// документу, поэтому он рисуется ПОВЕРХ, и значки оказывались нажимаемыми не везде
// (найдено владельцем 2026-08-11). `z-20` ставит кластер выше, подложка прячет то, что
// под ним осталось. Прозрачный кластер поверх чужого текста был бы кашей.
//
// Цвет — `--rf-canvas`, тот же токен, которым красит страницу `.rf-theme` (fields.css):
// оформление формы (фаза 22) меняет холст, и подложка обязана ехать за ним, иначе на
// тёмной форме под значками светилось бы белое пятно. Tailwind-цвет кабинета здесь не
// годится по той же причине.
const CLUSTER_BACKDROP = 'z-20 rounded-md bg-[var(--rf-canvas)]'

// Опции сенсора списка вариантов — МОДУЛЬНАЯ КОНСТАНТА, по той же причине, что у
// полотна (см. POINTER_OPTIONS в SlashEditor): `useSensor` мемоизирует дескриптор по
// ССЫЛКЕ на объект опций, поэтому литерал в теле компонента = новый дескриптор на
// каждый рендер = новое значение внутреннего контекста DndContext, а его читает каждая
// карточка варианта. Масштаб здесь меньше (варианты одного блока, не всё полотно), но
// образец тот же, и оставлять его рядом с его же починкой незачем.
const OPT_SENSOR_OPTIONS = { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }

// BlockRowBody — содержимое строки: меню действий, тогл обязательности, чип заголовка
// и сама поверхность (текст / варианты / инпут плейсхолдера / объектная остановка).
// Про dnd не знает НИЧЕГО и ни одного его контекста не читает — в этом весь смысл
// разреза (см. шапку BlockRow). Единственное исключение — список вариантов
// (OptionsInline), но у него СВОЙ DndContext, поэтому канвасный его не касается.
const BlockRowBody = memo(function BlockRowBody({
  block,
  formId,
  groupHandle,
  groupHasAnswer = false,
  requiredFor,
  insideQuestion = false,
  firstOfForm = false,
  needsCaption = false,
  openMenuOnMount,
  actionOpen,
  setActionOpen,
  onAddCaption,
  onAddBelow,
  onBackspaceAtStart,
  onBackspaceDelete,
  onDeleteBlock,
  onAnswerAction,
  onArrow,
  onRowShift,
}: BlockRowProps & {
  actionOpen: boolean
  setActionOpen: (open: boolean) => void
  onAddCaption: () => void
}) {
  const engine = useFocusEngine()
  // Обёртка структурных команд, называющая потерю заголовка (§4.3 спеки фазы 15):
  // строка теперь двигается и удаляется отдельно от своего вопроса, и каждый такой
  // жест может оставить поле без имени в выгрузке. Зовут её ровно те обработчики,
  // которые правят СОСТАВ документа, — набор текста и смена типа сюда не входят.
  const captionGuard = useCaptionGuard(engine)
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const moveBlock = useBuilderStore((s) => s.moveBlock)
  const moveGroup = useBuilderStore((s) => s.moveGroup)
  const changeBlockType = useBuilderStore((s) => s.changeBlockType)
  const makeQuestion = useBuilderStore((s) => s.makeQuestion)
  const makeField = useBuilderStore((s) => s.makeField)
  const duplicateBlock = useBuilderStore((s) => s.duplicateBlock)
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
  // Пометка «действие попапа уже поставило каретку»: см. onOpenChange у BlockActionMenu.
  const movedCaretRef = useRef(false)
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
    isTextRow && row.placeholderOnFocusOnly ? (labelFocused ? captionName : undefined) : captionName
  const isContent = isContentType(block.type)
  const isConsent = isTextRow && row.mark === 'check'
  // ОТМЕТКИ ВОПРОСА — звёздочка обязательности и два значка условий. Считаются ЗДЕСЬ, а
  // не внутри RowMarks: от их наличия зависит раскладка текстовой строки (см. ниже).
  //
  // Звёздочка — только у БЕЗУСЛОВНОЙ обязательности: `required` и `requiredIf`
  // взаимоисключающи по схеме (три состояния, ADR §10), и условное состояние показывает
  // свой значок, а не приглушённую звёздочку. Три состояния — три разных вида.
  // Обратный вход в обязательность — тумблер в попапе.
  const showRequired = requiredFor?.required === true
  const showMarks = showRequired
  // hasTextLine — у блока есть редактируемая строка текста: подписи/контент и consent.
  // Поля ввода строки не несут — их подпись живёт отдельным блоком.
  const hasTextLine = isTextRow
  const captionCls = isTextRow ? row.className : ''
  // Чем набирается ПУСТАЯ строка этого типа. Факт объявлен у типа (kinds/<type>.tsx),
  // ветки по типу здесь нет намеренно — см. шапку BlockRow.
  const captionMarks = textIsBold(block.type) ? BOLD_MARKS : undefined
  // Якорь кластера у блока без подписи: обёртка ПОЛЯ, если она есть (placeholder-типы),
  // иначе сама строка. Кластер один и тот же элемент — меняется только предок, от
  // которого считается его absolute (см. места отрисовки ниже).
  //
  // МИНА: это единственный источник выбора места, и оба места спрашивают ИМЕННО ЕГО.
  // Разведёшь условия по месту (одно про поверхность, другое про подпись) — при первом
  // же расхождении кластер отрисуется ДВАЖДЫ: строка и обёртка нарисуют по своему.
  const marksAtField = !hasTextLine && row?.surface === 'placeholder'

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
    // Поверхность ТЕКСТА (§3.3 спеки фазы 16): стрелка и Backspace уходят со строки
    // только с края каретки, печатный символ и «/» идут в сам текст — поэтому
    // обработчиков printable/slash у неё нет (слеш-меню ведёт onLabelChange выше).
    handleRowKeys(e, {
      actionMenu: () => setActionOpen(true),
      deleteBlock: () => onDeleteBlock(block.id),
      // Cmd/Ctrl+Enter — к контролу ответа группы (§3.2).
      answerAction: () => onAnswerAction(block.id),
      // Alt+Shift+↑/↓ — перенос ГРУППЫ целиком (§3.2). Каретка остаётся на месте: id
      // блока стабилен, groupId от перестановки не меняется (regroup якорит по id),
      // строка не перемонтируется.
      moveGroup: (dir) => moveGroup(block.id, dir),
      // Mod+Alt+→/← — в ряд с предыдущим вопросом и обратно (§5). Каретка едет с
      // блоком по той же причине, что у moveGroup: id стабилен, ремаунта нет.
      rowShift: (side) => onRowShift(block.id, side),
      moveItem: (dir) => captionGuard(() => moveBlock(block.id, dir)),
      arrow: (dir) => onArrow(block.id, dir),
      arrowLeaves: (dir) => (dir === 'up' ? c.caretAtStart() : c.caretAtEnd()),
      // Enter — новый блок после группы; Shift+Enter — внутрь группы (§3.2).
      enter: (ev) => onAddBelow(block.id, { inside: ev.shiftKey }),
      // Каретка схлопнута в начале блока. Решение принимает родитель (знает соседей):
      // предыдущий блок — картинка → удалить её (как Backspace перед элементом в
      // текстовом документе), иначе пустой текущий блок схлопнуть в предыдущий.
      backspace: () => onBackspaceAtStart(block.id),
      backspaceHandles: () => c.caretAtStart(),
    })
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
          : changeBlockType(block.id, item.type, item.preset)
    setSlash(null)
    engine.focusBlock(focusId, 'end')
  }

  // Субъект НАСТРОЕК попапа (фаза 16, §4.2 спеки). Механизм не изобретается, а
  // обобщается: requiredFor — это ровно «строка представляет поле своего вопроса»
  // (считает его GroupRow, который один знает состав группы). Отсюда правило целиком:
  // кликнули по подписи собранного вопроса — правим его ПОЛЕ (тип, обязательность, а
  // с 16.4 и имя); кликнули по голой строке ответа — её саму; по контенту или одинокой
  // подписи — их самих, и типового раздела у них нет.
  //
  // Общие действия (удалить, дублировать) остаются адресованы СТРОКЕ, по которой
  // кликнули, — и на подписи это значит «вопрос целиком», потому что подпись владеет
  // группой во всех жестах (§4 EDITOR): мусорка сносит группу, драг тащит группу,
  // дублирование копирует вопрос.
  const settingsSubject = requiredFor ?? block

  // Выбор типа ИЗ ПОПАПА адресован субъекту настроек и МЕНЯЕТ ЕГО ТИП — всегда, когда
  // субъект отвечаемый: и на подписи (тип ответа вопроса), и на самой строке ответа.
  // Через правило ВСТАВКИ (`makeQuestion`/`makeField`, «инпут не встраивается в чужую
  // группу») попап идти не может: для блока внутри группы вставка кладёт новый блок
  // НИЖЕ, не трогая исходный, — то есть «сменить тип» ничего не меняет, а плодит
  // второй вопрос. Слеш-меню и «+» остаются вставкой: там автор добавляет, а не
  // переназначает, и правило им не трогается (pickType выше).
  //
  // Лэйаут-типы остаются вставкой/конверсией самой строки: абзац не может быть ответом
  // вопроса, и притворяться, что может, попап не должен.
  function pickTypeForSettings(item: MenuItem) {
    if (isAnswerableType(settingsSubject.type) && item.group !== 'layout') {
      engine.focusBlock(changeBlockType(settingsSubject.id, item.type), 'end')
      return
    }
    pickType(item)
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

  // Высота кластеров значков = высота ПЕРВОЙ строки блока (объявлена типом, fields.css —
  // источник самих чисел). Кластеры absolute и центрируют значок по своей высоте, поэтому
  // только так они стоят на уровне того, чем строка правится: у текстовой строки это
  // line-height (28px у вопроса и заголовка раздела, 24px у остального), у строки с
  // КОНТРОЛОМ — --rf-control-h (36px). Разница видна сразу: с высотой текста кластер у
  // поля вставал на 6px выше его середины (высота поля 36 = 6 паддинга + 24 строка + 6).
  const rowLineH = row?.lineH ?? 'h-6'

  // Кластер отметок строится ОДИН РАЗ и отдаётся одному из двух мест (см. marksAtField):
  // меняется только предок, от которого считается его absolute, а не сам элемент.
  const marksCluster = showMarks ? (
    <RowMarks requiredFor={requiredFor} showRequired={showRequired} lineH={rowLineH} />
  ) : null

  return (
    <>
      {/* Меню действий блока (Cmd+. §3.3): якорь — нулевой span в левом absolute-поле
          строки, сам поповер порталится. onPickType — тот же pickType, что у слеш-меню
          (makeQuestion/makeField/changeBlockType + фокус на результат). */}
      <BlockActionMenu
        open={actionOpen}
        // Закрытие попапа — тоже операция полотна, и каретка после неё обязана быть
        // определена (§12). Возврат фокуса Radix'ом на якорь (нулевой span) мы гасим
        // сами, поэтому по умолчанию каретка возвращается НА СВОЮ СТРОКУ — это верно и
        // для Esc, и для клика мимо, и для действий, которые строку не покидают
        // (обязательность). Действия, уводящие каретку сами (дублировать, удалить,
        // сменить тип), помечаются movedCaretRef — иначе возврат на строку затёр бы их
        // фокус, поставленный мгновением раньше.
        onOpenChange={(open) => {
          setActionOpen(open)
          if (open) return
          if (!movedCaretRef.current) engine.focusBlock(block.id, 'end')
          movedCaretRef.current = false
        }}
        block={block}
        subject={settingsSubject}
        anchor={<span aria-hidden="true" className="pointer-events-none absolute left-0 top-1.5" />}
        // Обязательность меню правит там же, где звёздочка, — в отвечаемом блоке
        // группы. Поэтому на подписи вопроса строка есть (раньше не было: подпись
        // ответов не собирает, а флаг — как раз про её вопрос). С фазы 21 это не пункт
        // «сделать обязательным», а три состояния: нет / всегда / по условию.
        requiredFor={requiredFor}
        // Каретка уходит на копию (§12): без этого после «Дублировать» активным
        // элементом остаётся body — поповер закрылся, а возврат фокуса на его якорь
        // мы гасим сами.
        onDuplicate={() => {
          const copy = duplicateBlock(block.id)
          movedCaretRef.current = true
          if (copy) engine.focusBlock(copy, 'end')
        }}
        onDelete={() => {
          movedCaretRef.current = true
          onDeleteBlock(block.id)
        }}
        onPickType={(item) => {
          movedCaretRef.current = true
          pickTypeForSettings(item)
        }}
      />

      {/* Второе место кластера отметок: у блока БЕЗ подписи текстовой строки нет, и
          цепляться инлайн не к чему. Тогда кластер absolute, и вопрос лишь в том, ЧТО
          ему якорь. Строка тянется на всю колонку (700px), а поле упирается в
          --rf-input-max (320px) — прицепленный к строке кластер висел бы в полуметре
          пустоты правее поля. Поэтому у поля с плейсхолдером он уезжает в .rf-field-wrap
          (marks у AnswerField ниже): та коробка ширины САМОГО поля. У остальных
          поверхностей своей коробки нет, и кластер остаётся при строке.
          Инлайн-место — в ветке hasTextLine ниже. */}
      {showMarks && !hasTextLine && !marksAtField ? marksCluster : null}

      {/* Единственная подсказка, оставшаяся у строки (решение владельца 2026-07-29):
          голой строке ответа предлагается дать заголовок. Прочие чипы сняты — карта
          клавиш целиком живёт в шпаргалке Mod+/. Компонент сам решает, рисовать ли
          себя (каретка на этой строке), и ничего не рисует, когда её здесь нет. */}
      {needsCaption && (
        <CaptionChip rowId={block.id} lineH={rowLineH} onAddCaption={onAddCaption} />
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
            <div className={isConsent || showMarks ? 'flex items-start gap-2' : undefined}>
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
                // Подстановка ответа по «@» (docs/design/mentions.md): доступна в любой
                // текстовой строке полотна — подписи вопроса, заголовке раздела, абзаце,
                // тексте согласия. Источники ищутся ОТ ЭТОГО блока, поэтому строка и
                // передаёт свой id.
                mentionsFor={block.id}
                defaultMarks={captionMarks}
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
                // МИНА: вернёшь w-full под кластером отметок — он уедет к правому краю
                // строки, а не встанет за текстом (строка растянется на весь flex-ряд).
                // Без него строка сжимается по содержимому, max-w-full держит длинное
                // слово.
                className={`block bg-transparent outline-none ${captionCls} ${
                  showMarks ? 'max-w-full' : 'w-full'
                }`}
              />
              {showMarks && (
                <RowMarks
                  requiredFor={requiredFor}
                  showRequired={showRequired}
                  lineH={rowLineH}
                  inline
                />
              )}
            </div>
          </div>
        </SlashMenu>
      ) : row?.surface === 'choice' ? (
        <div className="min-w-0">
          <OptionsInline
            block={block}
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
            // Отметки голого поля — в обёртку поля, а не при строке: см. marksAtField.
            // У поля с подписью отметки стоят на ней, и сюда не едут.
            marks={marksAtField ? marksCluster : undefined}
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
    </>
  )
})

// RowMarks — отметка обязательности вопроса. Инлайн (сразу за текстом подписи) — там
// же, где её увидит респондент; у поля БЕЗ подписи текстовой строки нет, и звёздочка
// висит БЕЙДЖЕМ в правом верхнем углу самого блока (решение владельца 2026-08-22).
//
// Место бейджа собственное, ЗА краем якоря его быть не может: там жёлоб ряда с ручкой
// ширины, а у объектной остановки — соседняя колонка. `right-1` держит бейдж В колонке,
// отрицательный `top` поднимает над верхней границей блока.
//
// МИНА: подъём на 12px разводит бейдж с ГЛИФОМ ТИПА, который у многострочного поля
// стоит у верхней строки, а не по центру (glyphTop в FieldWrap). Поднимешь меньше —
// подложка бейджа накроет глиф. История — JOURNAL, «Задача вне плана. Ширина колонки
// перетаскиванием».
//
// Значков условий здесь больше НЕТ: правило перестало быть невидимым свойством вопроса
// и стоит на полотне своей строкой — блоком `logic` (ADR §10). Помечать вопрос второй
// раз значило бы завести второе место, где живёт одно состояние.
function RowMarks({
  requiredFor,
  showRequired,
  lineH,
  inline = false,
}: {
  requiredFor?: Block
  showRequired: boolean
  lineH: string
  inline?: boolean
}) {
  return (
    <div
      className={
        inline
          ? `flex shrink-0 ${lineH} items-center`
          : 'absolute -top-3 right-1 z-10 flex items-center rounded-full bg-[var(--rf-canvas)]'
      }
    >
      {showRequired && <RequiredToggle block={requiredFor!} />}
    </div>
  )
}

// RequiredToggle — звёздочка обязательности. Монтируется только у обязательного
// вопроса, поэтому действие у неё одно: снять обязательность.
//
// Обязательность ПО УСЛОВИЮ звёздочки не получает и не снимает: её задаёт действие в
// блоке `logic` на полотне, и снимать её надо там же, где задавали (ADR §10).
function RequiredToggle({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  return (
    <button
      type="button"
      aria-label="Обязательный вопрос — снять"
      title="Обязательный вопрос — снять"
      onClick={() => updateBlock(block.id, { required: false })}
      className="flex size-5 items-center justify-center rounded text-primary hover:bg-muted"
    >
      <Asterisk className="size-4" />
    </button>
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

  // Поверхность ОБЪЕКТА (§3.3 спеки фазы 16): своего текста у неё нет, поэтому стрелка
  // уходит на соседнюю строку всегда, Backspace сносит блок сразу, а печатный символ и
  // «/» засевают строку НИЖЕ. Порядок аккордов — общий (rowKeys.ts).
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Перехватываем клавиши, только когда фокус на самой остановке, а не во
    // внутреннем контроле (select шкалы, кнопки картинки) — тем нужны свои клавиши.
    if (e.target !== e.currentTarget) return
    handleRowKeys(e, {
      actionMenu: onOpenActions,
      deleteBlock: () => onDeleteBlock(block.id),
      // Cmd/Ctrl+Enter — «действие над объектом» (§3.2): на картинке открыть файловый
      // диалог (клик по скрытому input внутри остановки). У date/scale входного файла
      // нет — селектор ничего не найдёт, жест — no-op.
      answerAction: () =>
        ref.current?.querySelector<HTMLInputElement>('input[type="file"]')?.click(),
      moveGroup: onMoveGroup,
      // Mod+Alt+→/← — ряд (§5): у объектной остановки (date/scale/картинка в вопросе)
      // жест тот же, что на подписи — переносится ВОПРОС, а не строка.
      rowShift: onRowShift,
      // Alt+↑↓ двигает саму строку — включая строку ответа собранного вопроса (фаза
      // 15, §4.1): поле уходит из вопроса и возвращается тем же жестом.
      moveItem: onMove,
      arrow: (dir) => onArrow(block.id, dir),
      enter: () => onAddBelow(block.id),
      backspace: () => onBackspaceDelete(block.id),
      slash: () => onAddBelow(block.id, { openMenu: true }),
      printable: (key) => onAddBelow(block.id, { seed: key }),
    })
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
  marks,
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
  // Кластер отметок голого поля (у поля с подписью отметки стоят на ней). Приезжает
  // готовым элементом и уходит в FieldWrap — обёртка поля и есть его якорь.
  marks?: ReactNode
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
  const hint = focused ? 'Плейсхолдер ответа' : undefined

  // ↑ с начала / ↓ с конца поля — уход на соседнюю строку (§2.1). Backspace в пустом
  // плейсхолдере УДАЛЯЕТ поле и уводит каретку на предыдущую остановку — единое
  // поведение всех поверхностей ответа (решение владельца 2026-07-26, отменяет
  // «поле — необязательный лист, Backspace его только пропускает» от 2026-07-24):
  // объект сносится Backspace'ом, последний вариант choice уносит свой блок, и
  // плейсхолдер не имеет права быть исключением. Осиротевшая подпись — законное
  // состояние: в неё подсаживают новый блок ответа. Left/Right и вертикаль внутри
  // длинного текста остаются нативными (caret-проверка на краю).
  function onFieldKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const el = e.currentTarget
    const c = textCaret(el)
    handleRowKeys(e, {
      actionMenu: onOpenActions,
      deleteBlock: onDeleteBlock && (() => onDeleteBlock(block.id)),
      rowShift: onRowShift,
      // moveGroup поверхность НЕ объявляет — и потому цепочка глушит Alt+Shift+↑↓, а не
      // пропускает его в moveItem. Правило общее (`rowKeys.ts`), рукописных заплат на
      // отдельных поверхностях быть не должно.
      moveItem: onMove,
      arrow: onArrow && ((dir) => onArrow(block.id, dir)),
      // Стрелка уходит со строки только с края каретки: вертикаль внутри длинного
      // плейсхолдера остаётся нативной.
      arrowLeaves: (dir) => (dir === 'up' ? c.caretAtStart() : c.caretAtEnd()),
      backspace: onBackspaceDelete && (() => onBackspaceDelete(block.id)),
      backspaceHandles: () => el.value === '',
    })
  }
  // Плейсхолдер правится многострочно только у длинного ответа — факт его типа. От него
  // же зависит положение глифа (к верхней строке, а не по центру высоты).
  const fieldRow = rowFacts(block.type)
  const multiline = fieldRow?.surface === 'placeholder' && !!fieldRow.multiline

  // Обёртка — якорь глифа типа и кластера отметок; ширину берёт из .rf-field-wrap
  // (index.css), где стоит тот же потолок --rf-input-max, что у поля. Просвет
  // подпись→поле (12px) даёт групповой контейнер (зазор внутреннего ряда в GroupRow) — свой mt тут не
  // нужен (был бы двойным отступом и ломал ритм 13.3).
  const wrap = (control: ReactNode, wide = false) => (
    <FieldWrap block={block} wide={wide} glyphTop={multiline} marks={marks}>
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
// ЯКОРЬ ЗАМЕРА и два числа ритма списка: карточка в потоке не имеет вертикальных
// отступов (их несёт gap контейнера), поэтому у госта вычитать нечего; просвет списка —
// 12px (.rf-options), и линия встаёт ровно посередине между карточками.
const OPT_ANCHOR = 'data-option-id'
const OPT_GAP = 6
const OPT_GUTTER = 12

function OptionsInline({
  block,
  onLeaveTop,
  onArrow,
  onAddBelow,
  onDeleteBlock,
  onBackspaceDelete,
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
  const setOptionRowWidths = useBuilderStore((s) => s.setOptionRowWidths)
  const takeOptionOwnRow = useBuilderStore((s) => s.takeOptionOwnRow)
  const moveOptionAfter = useBuilderStore((s) => s.moveOptionAfter)
  const removeOption = useBuilderStore((s) => s.removeOption)
  const duplicateOption = useBuilderStore((s) => s.duplicateOption)
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
  // ПРИЗРАК ЖИВЁТ, ПОКА АКТИВЕН ВОПРОС (решение владельца 2026-08-16): строка
  // «добавить» — приглашение автору, который сейчас здесь, а не постоянная деталь
  // формы. Мерка активности — та же, по которой показывается чип подписи и карта
  // клавиш (activeRow), но берётся она по ГРУППЕ, а не по блоку: каретка на
  // заголовке вопроса значит «автор работает над этим вопросом», и список вариантов
  // не имеет права схлопнуться у него под рукой.
  //
  // ИСКЛЮЧЕНИЕ — ПУСТОЙ СПИСОК: у него, кроме призрака, нет ни одной строки, и без
  // него неактивный блок исчез бы с полотна целиком. Исчезнувший блок нечем
  // активировать мышью — кликать не по чему, — то есть правило само отрезало бы себе
  // вход. Пустой список законен: блок рождается без вариантов.
  const activeRow = useActiveRow()
  const activeGroup = useBuilderStore(
    (s) => s.blocks.find((b) => b.id === activeRow?.id)?.groupId,
  )
  const showGhost = options.length === 0 || activeGroup === block.groupId
  const optionRefs = useRef(new Map<string, HTMLInputElement | null>())
  const ghostRef = useRef<HTMLInputElement>(null)
  // Id варианта, который тащат (null — драга нет): от него зависит, показывать ли зоны.
  const [optDrag, setOptDrag] = useState<string | null>(null)
  const optionIds = useMemo(() => options.map((o) => o.id), [options])
  // РАСКЛАДКА СПИСКА ДЛЯ ПРИЦЕЛА — вне кадра драга: прицел зовётся на каждое движение
  // указателя, и пересборка единиц 60 раз в секунду была бы мусором (§5.3 EDITOR.md).
  const units = useMemo(() => optionUnits(options), [options])
  // Ответы жеста живут в ref'ах, а в состояние их переносит rAF-цикл — как на полотне:
  // цель и зона считаются в collisionDetection (там есть указатель и измеренные
  // прямоугольники), а setState оттуда 60 раз в секунду перерисовывал бы вопрос впустую.
  const targetRef = useRef<DropTarget | null>(null)
  const zoneRef = useRef<string | null>(null)
  const nearRef = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const frameRafRef = useRef(0)
  const frameActiveRef = useRef<string | null>(null)
  const [dropLine, setDropLine] = useState<Rect | null>(null)
  const [sourceGhost, setSourceGhost] = useState<Rect | null>(null)
  const [zoneId, setZoneId] = useState<string | null>(null)
  const [nearOption, setNearOption] = useState<string | null>(null)
  const hoverZone = useMemo(() => (zoneId === null ? null : optionZoneTarget(zoneId)), [zoneId])
  // Что рисует ГОСТ ИСТОЧНИКА. Сама карточка в это время едет за курсором трансформой, её
  // layout-бокс остаётся на месте пустым — гост и есть эта дыра, названная вслух.
  const draggedOption = optDrag === null ? null : options.find((o) => o.id === optDrag)
  // Тот же порог активации, что у полотна: клик по ручке не должен начинать драг.
  // Клавиатурного сенсора здесь нет намеренно — у вариантов своя карта (Alt+↑↓,
  // Mod+Alt+←/→), и второй клавиатурный путь через ручку дублировал бы её.
  // Порог — та же константа, что у полотна и у обоих грипов: у списка вариантов свой
  // изолированный DndContext, но смысл числа один, и литерал здесь означал бы, что
  // правка константы рассинхронизирует слой вариантов (попап карточки начал бы
  // выскакивать «иногда» после драга).
  const optSensors = useSensors(useSensor(PointerSensor, OPT_SENSOR_OPTIONS))
  // Кадры жеста устроены ровно как у полотна (EDITOR.md §5, §5.2), и повторяются здесь
  // четыре его решения: зоны спрашиваются ПЕРВЫМИ и указателем; ответ зоны кладётся в ref,
  // а не отдаётся dnd-kit (id зоны нет в items, и `over`-зона гасит активной карточке
  // трансформу — «вариант пропадает из-под указателя»); цель считает список сам
  // (pickOptionTarget), а не конкурс центров; в кадрах без цели в `over` уходит тот
  // вариант, НАД которым указатель, лишь бы он не был пустым.
  const idleOverId = (activeId: string): string => {
    const near = nearRef.current
    if (near !== null && near !== activeId) return near
    return optionIds.find((id) => id !== activeId) ?? activeId
  }
  const optCollision: CollisionDetection = (args) => {
    const activeId = String(args.active.id)
    const zones = args.droppableContainers.filter((c) => optionZoneTarget(c.id) !== null)
    const zoneHit =
      zones.length === 0 ? [] : pointerWithin({ ...args, droppableContainers: zones })
    zoneRef.current = zoneHit.length > 0 ? String(zoneHit[0]!.id) : null
    if (zoneRef.current !== null) {
      // Вертикальную цель гасим: она осталась от последнего кадра ВНЕ зоны, и по ней
      // список рисовал бы линию к дропу, которого не будет. Приглашение, наоборот, не
      // трогаем — пока курсор в зоне, оно прибито к ней.
      targetRef.current = null
      const stay = args.droppableContainers.find((c) => String(c.id) === idleOverId(activeId))
      return stay ? [{ id: stay.id, data: { droppableContainer: stay, value: 0 } }] : []
    }
    const point =
      args.pointerCoordinates ??
      (() => {
        const r = flatRect(args.collisionRect)
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })()
    const boxes = new Map<string, Box>()
    for (const c of args.droppableContainers) {
      const raw = args.droppableRects.get(c.id)
      if (raw) boxes.set(String(c.id), flatRect(raw))
    }
    targetRef.current = pickOptionTarget(units, boxes, point, activeId)
    nearRef.current = pickHoverOption(units, boxes, point, activeId)
    const overId = targetRef.current?.afterId ?? idleOverId(activeId)
    const hit = args.droppableContainers.find((c) => String(c.id) === overId)
    return hit ? [{ id: hit.id, data: { droppableContainer: hit, value: 0 } }] : []
  }

  // Кадр жеста: гост источника (место, откуда карточку вынули) и линия вставки. Гост —
  // ДО всякой цели: он про источник, и курсор в зоне (цели нет вовсе) его не отменяет.
  function updateOptFrame(activeId: string) {
    setNearOption(nearRef.current)
    setZoneId(zoneRef.current)
    const root = listRef.current
    if (!root) return
    setRect(setSourceGhost, measureSlot(root, [activeId], OPT_ANCHOR, 0))
    const target = targetRef.current
    if (!target) return void setRect(setDropLine, null)
    setRect(setDropLine, measureLine(root, target.lineIds, target.before, OPT_ANCHOR, OPT_GAP))
  }

  function startOptFrames(activeId: string) {
    frameActiveRef.current = activeId
    cancelAnimationFrame(frameRafRef.current)
    const tick = () => {
      const id = frameActiveRef.current
      if (id === null) return
      updateOptFrame(id)
      frameRafRef.current = requestAnimationFrame(tick)
    }
    frameRafRef.current = requestAnimationFrame(tick)
  }

  function stopOptFrames() {
    frameActiveRef.current = null
    cancelAnimationFrame(frameRafRef.current)
    setOptDrag(null)
    setDropLine(null)
    setSourceGhost(null)
    setZoneId(null)
    setNearOption(null)
    targetRef.current = null
    zoneRef.current = null
    nearRef.current = null
  }

  // Страховка на анмаунт посреди жеста (удалили блок, ушли с маршрута): rAF-цикл не
  // должен пережить список.
  useEffect(() => () => cancelAnimationFrame(frameRafRef.current), [])
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
    // Выход из списка — как раньше Enter в пустом последнем варианте: новая строка
    // после группы. Вариантов так и не появилось — блок уходит вместе с призраком
    // (каретку уже забрала новая строка, поэтому уводить её отсюда не нужно).
    const leaveList = () => {
      onAddBelow(block.id)
      if (options.length === 0) removeBlock(block.id)
    }
    const toLastOption = () => optionRefs.current.get(last!.id)?.focus()
    handleRowKeys(e, {
      actionMenu: onOpenActions,
      deleteBlock: () => onDeleteBlock(block.id),
      // Mod+Enter на призраке делает то же, что Enter: до этапа 16.6 он попадал в
      // общую ветку `enter` (голый матчер модификаторы не исключает), и поведение
      // сохранено — объявлено явно вместо того, чтобы держаться на порядке веток.
      answerAction: leaveList,
      enter: leaveList,
      // Стирать в призраке нечего: либо возвращаемся к последнему варианту, либо —
      // если их нет — уходит сам блок, как на любой пустой поверхности ответа.
      backspace: () => (last ? toLastOption() : onBackspaceDelete(block.id)),
      arrow: (dir) => {
        if (dir === 'down') return onArrow(block.id, 'down')
        if (last) toLastOption()
        else onLeaveTop()
      },
    })
  }

  // Поверхность СПИСКА ВАРИАНТОВ (§3.3 спеки фазы 16). i — индекс варианта в options.
  function onOptionKeyDown(e: KeyboardEvent<HTMLInputElement>, optionId: string, i: number) {
    const empty = e.currentTarget.value === ''
    const isLast = i === options.length - 1
    // Новый вариант сразу ПОСЛЕ текущего (Д5), фокус на него.
    const addAfter = () => {
      pendingFocus.current = addOptionAfter(block.id, optionId)
    }
    const moveBy = (dir: ArrowDir) => {
      const target = dir === 'up' ? i - 1 : i + 1
      if (target >= 0 && target < options.length) {
        moveOption(block.id, optionId, dir)
        pendingFocus.current = optionId
      }
    }
    handleRowKeys(e, {
      actionMenu: onOpenActions,
      // Явное удаление всего choice-блока (не варианта) — вариант удаляет Backspace.
      deleteBlock: () => onDeleteBlock(block.id),
      // Cmd/Ctrl+Enter — тот же жест «действие над ответом» (§3.2): новый вариант.
      // Выходом из списка он не бывает — эта ветка ниже проверяет голый Enter.
      answerAction: addAfter,
      // Alt+Shift+↑↓ у варианта двигает ВАРИАНТ, как Alt+↑↓. Поведение сохранено с
      // прошлого устройства (там оно держалось не решением, а отсутствием ветки
      // moveGroup — Alt+Shift подходит под матчер Alt), но теперь объявлено вслух:
      // цепочка иначе аккорд глушит. Кандидат на решение владельца — карта клавиш
      // обещает здесь «перенести вопрос».
      moveGroup: moveBy,
      // Mod+Alt+→/← — ряд вариантов (§5.1): та же механика и те же аккорды, что у
      // вопросов. Каретка едет с вариантом (фокус на тот же optionId — id стабилен).
      // Ряды есть не у всякого списка: у dropdown их нет (список живёт в нативном
      // select), и жест уходит ВОПРОСУ.
      rowShift: (side) => {
        if (!optionRows) return onRowShift(side)
        const prev = options[i - 1]
        if (side === 'left') takeOptionOwnRow(block.id, optionId)
        else if (prev) {
          // Клавиатура даёт СЛЕДУЮЩУЮ колонку ряда цели — тот же жест, что был у списка
          // до зон: «встань справа от предыдущего». Номер считаем по раскладке БЕЗ
          // активного (он мог стоять в этом же ряду, и тогда его колонка в счёт не идёт).
          const rest = options.filter((o) => o.id !== optionId)
          const row = packOptionRows(rest).find((r) =>
            r.some((c) => c.some((o) => o.id === prev.id)),
          )
          placeOptionInRow(block.id, optionId, prev.id, (row?.length ?? 1) + 1, true)
        }
        pendingFocus.current = optionId
      },
      // Alt+↑/↓ — перенос варианта; каретка едет с ним (фокус на тот же optionId).
      moveItem: moveBy,
      // Единый обход (§2.1): соседний вариант, а за краем списка — соседняя строка.
      arrow: (dir) => {
        const near = dir === 'up' ? options[i - 1] : options[i + 1]
        if (near) return void optionRefs.current.get(near.id)?.focus()
        if (dir === 'up') onLeaveTop()
        else onArrow(block.id, 'down')
      },
      enter: () => {
        // Выход из списка: пустой последний вариант удаляем, новая текстовая строка
        // ложится после всей группы (как «Enter в конце списка» в текстовых
        // редакторах). Строку заводим ДО удаления: последний вариант уносит с собой
        // сам блок, и позицию «после группы» родителю было бы уже не от чего считать —
        // новая строка улетела бы в конец полотна.
        if (isLast && empty) {
          onAddBelow(block.id)
          removeOption(block.id, optionId)
          return
        }
        addAfter()
      },
      backspace: () => removeOptionAt(optionId, i),
      backspaceHandles: () => empty,
    })
  }

  // ДРОП — из ОДНОГО ответа, как на полотне (§5.2): что показала подсказка, то и
  // исполняется. Зона взята — её команда (собрать ряд/стопку), иначе цель под указателем
  // (перенос «после такого-то»; номер колонки, если цель внутри колонки). Фокус не
  // трогаем ни в одном исходе — «dnd мышью фокус не трогает» (§2.4).
  function onOptionDragEnd(e: DragEndEvent) {
    const active = String(e.active.id)
    const zone = zoneRef.current === null ? null : optionZoneTarget(zoneRef.current)
    const target = targetRef.current
    stopOptFrames()
    if (zone !== null) {
      if (zone.optionId !== active) {
        placeOptionInRow(block.id, active, zone.optionId, zone.col, zone.insert)
      }
      return
    }
    if (target !== null) moveOptionAfter(block.id, active, target.afterId, target.column)
  }

  const rows = packOptionRows(options)
  const index = new Map(options.map((o, i) => [o.id, i]))
  // Ряд, у которого горят зоны, — РОВНО ОДИН, и адресуется он участником, отличным от
  // перетаскиваемого (optionDrop.ts, там же оба довода). Пока курсор В зоне, приглашение
  // прибито к ней: иначе, зайдя в зону у края, автор увёл бы её из-под собственного
  // курсора.
  const inviteId =
    optDrag === null ? null : (hoverZone?.optionId ?? inviteOptionRowId(units, nearOption, optDrag))
  // Горит ли ЭТА полоса: зона под курсором известна списку (zoneId), `isOver` у dnd-kit
  // зоны не спрашивают — они больше не его `over`.
  const zoneHot = (col: number, insert: boolean): boolean =>
    hoverZone !== null &&
    hoverZone.optionId === inviteId &&
    hoverZone.col === col &&
    hoverZone.insert === insert

  return (
    // Просвет подпись→первый вариант (12px) даёт групповой контейнер, не свой mt
    // (ритм 13.3).
    //
    // Dnd вариантов — СВОЙ DndContext, изолированный от блочного и группового слоёв
    // полотна (§5.1, EDITOR §5): третий слой в общем фильтре коллизий стал бы
    // конкурентом строкам, а его сенсор активируется только своей ручкой, поэтому
    // вложенность контекстов драги не смешивает.
    //
    // Always здесь, скорее всего, ЛИШНИЙ: во время жеста он и `WhileDragging` меряют
    // одинаково (`isDisabled()` в useDroppableMeasuring различает их только в покое), а
    // на полотне снятие `Always` убрало 301 синхронный getBoundingClientRect на каждую
    // структурную правку. НЕ снят потому, что путь вариантов отдельно не замерен, а
    // менять поведение драга без замера в этой ветке уже выходило боком. Остаток — TD-55.
    <DndContext
      sensors={optSensors}
      collisionDetection={optCollision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={(e) => {
        const id = String(e.active.id)
        setOptDrag(id)
        startOptFrames(id)
      }}
      onDragCancel={stopOptFrames}
      onDragEnd={onOptionDragEnd}
    >
      {/* СТРАТЕГИЯ — та же, что у полотна: соседи НЕ расступаются, двигается только сам
          перетаскиваемый элемент, а место называет линия (EDITOR.md §5.2). Расступание
          вариантов было последним местом редактора, где цель уезжала из-под курсора. */}
      <SortableContext items={optionIds} strategy={canvasSorting}>
        {/* rf-options/rf-row — ТЕ ЖЕ классы, что у превью и рендерера (fields.css), а
            не их Tailwind-копия: оттуда приезжает и ритм списка (12px), и потолок
            карточки min(--rf-input-max, 100%). Копия давала бы ритм, но не потолок —
            длинный вариант в редакторе был бы шире, чем у респондента.
            relative — система координат оверлеев жеста (линия и гост меряются от него). */}
        <div className="rf-options relative" ref={listRef}>
          {/* Оверлеи — absolute ДО списка в DOM и позиционируются ПРЯМО, без своей
              анимации: те же два урока, что у полотна (§5). */}
          {sourceGhost && draggedOption && (
            <SourceSlot rect={sourceGhost}>
              <GhostFrame>
                <OptionGhost
                  label={draggedOption.label}
                  multiple={!isSingleChoiceType(block.type)}
                  badge={optionKey(index.get(draggedOption.id)!)}
                />
              </GhostFrame>
            </SourceSlot>
          )}
          {dropLine && <DropLine rect={dropLine} />}
          {rows.map((row) => {
            const cols = row.length
            // Зоны показывает только приглашённый ряд. Границ на одну больше, чем
            // колонок, а подвал есть у каждой колонки настоящей секции: у полноширинного
            // ряда колонок нет, и «в стопку» там значить нечему (placeOptionInRow такой
            // дроп отвергнет). Границы гаснут на потолке: обещать колонку, которой не
            // будет, нельзя.
            const zones = inviteId !== null && row.some((c) => c.some((o) => o.id === inviteId))
            const canAdd = cols < MAX_COLUMNS
            // Доли колонок — тот же раскладчик и то же правило, что у вопросов; ячейка
            // здесь настоящая .rf-cell, поэтому доля едет переменной, как у респондента.
            const widths = optionRowWidths(row)
            return (
              // РЯД — КОНТЕЙНЕР ВСЕГДА, даже об одном варианте: он якорь зон и
              // единственный бокс, чья геометрия не зависит от содержимого. Тип узла
              // менять посреди жеста нельзя (урок снятого дублёра, §5.1), а обёртка,
              // появляющаяся с началом драга, ремаунтила бы карточку вместе с её
              // инпутом — каретка выпадала бы в body.
              //
              // МИНА: у ряда из одного колонка обязана ОБНИМАТЬ карточку
              // (align-items от холста), иначе .rf-cell растянет её до потолка
              // --rf-input-max, и одинокий вариант в редакторе станет 320px там, где у
              // респондента он по тексту. Замерено: 118px против 320px.
              <div key={row[0]![0]!.id} className="rf-row relative items-start">
                {zones && canAdd && (
                  <SideDropZone
                    id={optionZoneId(inviteId!, 1, true)}
                    side="left"
                    railOff={false}
                    hot={zoneHot(1, true)}
                  />
                )}
                {zones && canAdd && (
                  <SideDropZone
                    id={optionZoneId(inviteId!, cols + 1, true)}
                    side="right"
                    railOff={false}
                    hot={zoneHot(cols + 1, true)}
                  />
                )}
                {row.map((cell, i) => (
                  <div
                    key={cell[0]!.id}
                    className={`rf-cell relative self-start${
                      cols === 1 ? ' [align-items:var(--rf-align-items)]' : ''
                    }`}
                    // Доля — inline flex-grow, а не переменной, как у респондента: то
                    // же свойство правит жест ширины, и два способа записи на одной
                    // ячейке разъехались бы на первом же перетаскивании.
                    style={{ flexGrow: widths?.[i] }}
                    // Только у настоящей секции: у ряда из одного варианта обёртка стоит
                    // всегда (якорь зон), и метка сняла бы потолок карточки там, где ряда
                    // нет.
                    {...(cols > 1 ? { 'data-rf-cell': '' } : {})}
                  >
                    {/* Ручка ширины — тот же жест, что у вопросов; жёлоб списка 12px.
                        Во время драга вариантов не рисуется: список в этот момент
                        показывает свои три отклика и наведение не обслуживает. */}
                    {i > 0 && optDrag === null && (
                      <ColumnResizer
                        index={i}
                        gutter={OPT_GUTTER}
                        onCommit={(next) =>
                          setOptionRowWidths(block.id, row[0]![0]!.id, next)
                        }
                      />
                    )}
                    {zones && i > 0 && canAdd && (
                      <GapDropZone
                        id={optionZoneId(inviteId!, i + 1, true)}
                        hot={zoneHot(i + 1, true)}
                        gutter={OPT_GUTTER}
                      />
                    )}
                    {zones && cols > 1 && (
                      <FootDropZone
                        id={optionZoneId(inviteId!, i + 1, false)}
                        hot={zoneHot(i + 1, false)}
                        gutter={OPT_GUTTER}
                      />
                    )}
                    {cell.map((o) => (
                      <OptionCard
                        key={o.id}
                        block={block}
                        option={o}
                        // Номер (и буква) — по позиции в ПОЛНОМ списке: ряды порядок
                        // документа не меняют, и A/B/C обязаны остаться теми же, что до
                        // переноса.
                        index={index.get(o.id)!}
                        dragging={optDrag !== null}
                        inputRef={(el) => {
                          optionRefs.current.set(o.id, el)
                        }}
                        onKeyDown={(e) => onOptionKeyDown(e, o.id, index.get(o.id)!)}
                        onRemove={() => removeOptionAt(o.id, index.get(o.id)!)}
                        onDuplicate={() => {
                          // Каретка — на копию (§12), через тот же pendingFocus, что у
                          // остальных операций списка: варианта ещё нет в DOM, фокус
                          // ставится, когда массив приедет рендером.
                          const copy = duplicateOption(block.id, o.id)
                          if (copy) pendingFocus.current = copy
                        }}
                        rowFocus={rowFocus}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )
          })}
          {/* «Призрак» — пустая строка в конце списка вместо кнопки «Добавить вариант»
              (решение владельца 2026-07-26). Вариантом она не является и в схеме её
              нет: набранный в ней текст рождает НАСТОЯЩИЙ вариант, а призрак тут же
              появляется под ним. Так список набирается подряд, как текст, а пустые
              варианты перестают уезжать в опубликованную форму. */}
          {showGhost && (
            <GhostOption
              ref={ghostRef}
              multiple={!isSingleChoiceType(block.type)}
              // Буква будущего варианта — следующая за последним (у списка «один из
              // списка» глиф это бейдж, а не чекбокс). Пустой бейдж читался бы поломкой.
              nextKey={optionKey(options.length)}
              onType={(text) => {
                pendingFocus.current = addOption(block.id, text)
              }}
              // Клик по глифу рождает ПУСТОЙ вариант и уводит в него каретку (решение
              // владельца 2026-08-16). Набор текстом остаётся главным путём, но глиф,
              // который видно, обязан работать: невидимая кнопка была бы обманом.
              onAdd={() => {
                pendingFocus.current = addOption(block.id)
              }}
              onKeyDown={onGhostKeyDown}
              rowFocus={ghostFocus}
            />
          )}
        </div>
      </SortableContext>
    </DndContext>
  )
}

// GhostOption — пустая строка в конце списка вариантов: место, где список
// продолжается. Вариантом она НЕ является — в схеме её нет, значков у неё нет,
// перетащить и удалить нечего; поэтому и выглядит она неактивной (приглушена), пока
// в ней пусто. Первый же набранный символ рождает настоящий вариант с этим текстом,
// каретка переезжает в него, а призрак появляется строкой ниже — визуально текст
// остаётся на месте, а под ним открывается новая пустая строка.
//
// Почему не кнопка «Добавить вариант»: кнопка — отдельный жест и отдельная остановка,
// из-за которой список набирается «текст → мышь/Tab → текст». Призрак делает список
// обычным текстом, который набирают подряд.
//
// value всегда пустой: набранное уезжает в стор в тот же тик, поэтому призрак сам
// текст никогда не хранит — иначе он был бы вариантом-невидимкой со своим состоянием.
function GhostOption({
  ref,
  multiple,
  nextKey,
  onType,
  onAdd,
  onKeyDown,
  rowFocus,
}: {
  ref: React.RefObject<HTMLInputElement | null>
  // Тип списка решает, что стоит перед текстом: чекбокс или буквенный бейдж.
  multiple: boolean
  // Буква будущего варианта (null — их больше 26, бейджа не будет и у настоящего).
  nextKey: string | null
  onType: (text: string) => void
  onAdd: () => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  rowFocus: ReturnType<typeof useRowFocus>
}) {
  const placeholder = 'Добавить ответ'
  return (
    // Приглушён сильнее обычного (решение владельца 2026-07-26): строка обязана
    // читаться как приглашение, а не как ещё один вариант, который автор забыл
    // заполнить. Под наведением приглушение слабеет, в фокусе снимается совсем — в
    // строку уже набирают.
    //
    // МИНА: hover и focus-within правят ОДНО свойство, и у обоих одна специфичность —
    // побеждает тот класс, что позже в СОБРАННОМ CSS, а не в строке className
    // (web/CLAUDE.md). Замер: hover у Tailwind идёт после focus-within, поэтому голый
    // `hover:opacity-70` глушил бы строку, в которую сейчас набирают, стоило навести на
    // неё курсор. Отсюда `not-focus-within:` — состояния разведены, а не переспорены.
    // Проверяется только computed-стилем.
    <div
      // НАЖИМАЕТСЯ ВСЯ СТРОКА, а не один глиф (решение владельца 2026-08-16): клик по
      // ней рождает пустой вариант и уводит в него каретку. Клик мимо 20-пиксельного
      // чекбокса — тот же жест «добавить», и отвечать на него молчанием строка, у
      // которой курсор-указатель, не имеет права.
      //
      // preventDefault на mousedown гасит фокус ПРИЗРАКА: без него каретка успевает
      // сесть в его инпут и тут же уезжает в рождённый вариант — мигание на ровном
      // месте. Клавиатурный вход в призрак это не трогает (фокус туда ставят кодом).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAdd}
      className="relative flex cursor-pointer items-center opacity-45 transition-opacity focus-within:opacity-100 not-focus-within:hover:opacity-70"
    >
      <span className={`rf-option${multiple ? ' rf-option--check' : ''}`}>
        {/* Глиф будущего варианта — НАСТОЯЩИЙ, а не невидимый слот под него (решение
            владельца 2026-08-16): строка «добавить» выглядит следующим вариантом
            списка, и место под текст держит тем же классом, что у настоящего.
            Декоративен (span, aria-hidden) — как и глифы настоящих вариантов: жест
            принимает строка целиком, а имя ей даёт её инпут. */}
        <span aria-hidden="true" className={multiple ? 'rf-mark rf-mark--check' : 'rf-option-key'}>
          {multiple ? null : nextKey}
        </span>
        <span className="rf-option-edit" data-value={placeholder}>
          <input
            ref={ref}
            value=""
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={onKeyDown}
            {...rowFocus}
            // data-ghost — указатель вместо текстового курсора (index.css). Утилитой
            // это не решается: правило инпута карточки специфичнее её.
            data-ghost=""
            className="bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </span>
      </span>
    </div>
  )
}

// OptionActionMenu — попап варианта (фаза 16, решение владельца 7). Состав из двух
// пунктов и никаких настроек типа: у варианта их нет, а «в колонку» — свойство строки
// (раскладку списка задаёт она), не карточки. Отдельный маленький компонент, а не
// BlockActionMenu с флагами: у того субъект — блок, и половина его пунктов (сменить
// тип, обязательность) варианту бессмысленна.
function OptionActionMenu({
  open,
  onOpenChange,
  anchor,
  onDuplicate,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: ReactNode
  onDuplicate: () => void
  onDelete: () => void
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      <PopoverContent
        className="w-52 p-0"
        align="start"
        side="bottom"
        // Фокус после действия ставит сам список (pendingFocus/onLeaveTop) — возврат
        // Radix на якорь глушим, иначе каретка уезжает на кнопку значка (§12).
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <Command>
          <CommandList>
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  onDuplicate()
                  onOpenChange(false)
                }}
              >
                <Copy className="size-4" />
                Дублировать вариант
              </CommandItem>
              <CommandItem
                onSelect={() => {
                  onDelete()
                  onOpenChange(false)
                }}
              >
                <Trash2 className="size-4" />
                Удалить вариант
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// OptionGhost — НЕПОДВИЖНАЯ копия карточки для госта источника. Не OptionCard: у той
// внутри инпут и `useSortable`, то есть вторая карточка с тем же id в том же контексте и
// второй фокусируемый инпут в списке. Копия рисуется теми же классами rf-*, что оригинал,
// — гост обязан выглядеть картой, а не эскизом.
function OptionGhost({
  label,
  multiple,
  badge,
}: {
  label: string
  multiple: boolean
  badge: string | null
}) {
  return (
    <span className={`rf-option${multiple ? ' rf-option--check' : ''}`}>
      {multiple ? (
        <span className="rf-mark rf-mark--check" aria-hidden="true" />
      ) : (
        badge && (
          <span className="rf-option-key" aria-hidden="true">
            {badge}
          </span>
        )
      )}
      <span>{label || 'Вариант'}</span>
    </span>
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
  dragging,
  inputRef,
  onKeyDown,
  onRemove,
  onDuplicate,
  rowFocus,
}: {
  block: Block
  option: NonNullable<NonNullable<Block['settings']>['options']>[number]
  index: number
  // Идёт ли жест В ЭТОМ списке. Пока он идёт, наведение молчит у всех карточек, кроме
  // перетаскиваемой (§5 EDITOR.md): курсор с карточкой в руке проезжает по всему списку, и
  // кластеры значков зажигались бы у каждой, над которой он прошёл. Своей наведение
  // возвращается — иначе её грип перестаёт быть целью попадания и курсор теряет вид
  // grabbing.
  dragging: boolean
  inputRef: (el: HTMLInputElement | null) => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  // Удаление варианта с исходом каретки по контракту (§12) — считает список, он
  // один знает соседей. Мусорка и Backspace в пустом ведут в одну точку.
  onRemove: () => void
  // Дублирование варианта с исходом каретки на копию — тем же путём, что удаление:
  // список знает и соседей, и движок.
  onDuplicate: () => void
  rowFocus: ReturnType<typeof useRowFocus>
}) {
  const updateOption = useBuilderStore((s) => s.updateOption)
  const [menuOpen, setMenuOpen] = useState(false)
  const gripDownRef = useRef<{ x: number; y: number } | null>(null)
  // Своя ссылка на инпут вдобавок к колбэку списка: закрытие попапа обязано вернуть
  // каретку СЮДА (§12), а список знает своих детей только по карте id → элемент.
  const inputEl = useRef<HTMLInputElement | null>(null)
  // Действие из попапа само уводит каретку (дублирование — на копию, удаление — к
  // соседу; оба считает список). Тот же флаг и та же причина, что у BlockActionMenu:
  // возврат на свою карточку затёр бы поставленный мгновением раньше фокус.
  const movedCaretRef = useRef(false)
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
      // data-option-id — якорь замера для оверлеев жеста (линия и гост, updateOptFrame),
      // зеркало data-block-id у строки полотна.
      data-option-id={option.id}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        ...(isDragging ? DRAGGED_FADE : null),
      }}
      // Перетаскиваемая карточка — ТЕНЬ, а не карточка (dnd.ts, там же довод): тусклее
      // покоя, книзу растворяется маской, у инпута внутри гаснут фон и тень. Наведение на
      // время жеста гасится у всех, кроме неё.
      className={`group/opt relative flex items-center ${
        isDragging
          ? `z-10 pointer-events-auto ${DRAGGED_LOOK}`
          : dragging
            ? 'pointer-events-none'
            : ''
      }`}
    >
      {/* Кластер значков варианта — зеркало кластера строки: те же размеры, тот же
          порядок (удалить, перетащить — ручка ближе к тексту), то же проявление по
          hover своей карточки (group/opt: безымянный group занят строкой блока, и от
          него значки расцветали у всех вариантов разом — TD-31).
          Отступ тоже тот же (mr-1): ручки вариантов и ручки строк обязаны стоять в
          одну вертикаль — правый край у обоих кластеров на 4px левее колонки. Разойдись
          они, у списка получилось бы два этажа управления, различающихся парой
          пикселей. */}
      <div
        // Погашенный кластер прозрачен для указателя — то же правило и та же мина, что
        // у кластера строки: иначе он зажигается от собственной площади в левом поле.
        className={`${CLUSTER_BACKDROP} pointer-events-none absolute right-full mr-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/opt:pointer-events-auto group-hover/opt:opacity-100`}
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
        {/* Грип варианта — та же пара жестов, что у грипа строки (§4.1): тащим —
            перенос, кликаем — настройки. Состав попапа — «удалить» и «дублировать»
            (решение владельца 7): с решением 6 карточка варианта остаётся
            единственным местом, где списком управляют, и оставить её без попапа
            значило бы спрятать управление совсем. */}
        <OptionActionMenu
          open={menuOpen}
          // Закрытие без действия (Esc, клик мимо) возвращает каретку на свою
          // карточку. Без этого она падала в body — Radix ставит фокус на поповер при
          // открытии, а возврат на якорь мы гасим сами, — и вся клавиатура полотна
          // умирала до первого клика мышью (находка ревью 16.2б).
          onOpenChange={(open) => {
            setMenuOpen(open)
            if (open) return
            if (!movedCaretRef.current) inputEl.current?.focus()
            movedCaretRef.current = false
          }}
          onDuplicate={() => {
            movedCaretRef.current = true
            onDuplicate()
          }}
          onDelete={() => {
            movedCaretRef.current = true
            onRemove()
          }}
          anchor={
            <button
              type="button"
              aria-label="Настройки варианта"
              title="Настройки — клик, перенос — перетаскивание"
              className="flex size-5 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
              {...attributes}
              {...listeners}
              // Значки — не остановки обхода: каретка ходит по вариантам, а не по их
              // кнопкам. Ставим ПОСЛЕ спреда: attributes несут свой tabIndex, и порядок
              // здесь решает, чей победит.
              tabIndex={-1}
              // Свой onPointerDown перебивает одноимённый обработчик dnd-kit (он идёт
              // из спреда выше) — зовём его руками, иначе вариант перестаёт таскаться.
              // Тот же порядок пропов уже съедал драг у грипа строки.
              onPointerDown={(e) => {
                gripDownRef.current = { x: e.clientX, y: e.clientY }
                listeners?.onPointerDown?.(e)
              }}
              onClick={(e) => {
                const from = gripDownRef.current
                gripDownRef.current = null
                // Строго БОЛЬШЕ, как у сенсора dnd-kit (hasExceededDistance
                // сравнивает через >): при >= жест ровно на пороге пропадал бы молча —
                // сенсор драг не начал, а guard уже съел клик.
                if (
                  from &&
                  Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_ACTIVATION_DISTANCE
                )
                  return
                setMenuOpen(true)
              }}
            >
              <GripVertical className="size-4" />
            </button>
          }
        />
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
            ref={(el) => {
              inputEl.current = el
              inputRef(el)
            }}
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
