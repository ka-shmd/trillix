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
  PointerSensor,
  closestCenter,
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
import {
  type Block,
  DEFAULT_SUBMIT_LABEL,
  isCaptionType,
  MAX_SUBMIT_LABEL_LEN,
} from '@entities/formSchema'
import { useBuilderStore } from './storeContext'
import { type MenuItem } from './blockTypes'
import { noLayoutAnimation } from './dnd'
import { BlockRow } from './BlockRow'
import { createFocusEngine, FocusEngineProvider } from './focusEngine'
import { BlockTypeDialog } from './BlockTypeDialog'
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
export function SlashEditor({ formId, initialTitle }: { formId: string; initialTitle: string }) {
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
  // Фокус-движок полотна: один на инстанс (useMemo), строки берут его из контекста.
  const engine = useMemo(() => createFocusEngine(), [])
  // dragBlockId/overBlockId — активный БЛОК (не группа) и строка под ним: для
  // подсветки целевой группы и линии вставки при блочном драге. У группового драга
  // отклик нативный (sortable двигает группы сам), эти состояния не участвуют.
  const [dragBlockId, setDragBlockId] = useState<string | null>(null)
  const [overBlockId, setOverBlockId] = useState<string | null>(null)
  const [menuForId, setMenuForId] = useState<string | null>(null)
  // Ссылка на textarea заголовка формы: когда удаляют последний блок и полотно пустеет,
  // фокус переносим сюда, а не теряем в body.
  const titleRef = useRef<HTMLTextAreaElement>(null)
  // Диалог выбора типа (кнопка «+»): открыт ли и после какого блока вставлять
  // (null — в конец).
  const [insertOpen, setInsertOpen] = useState(false)
  const [insertAfterId, setInsertAfterId] = useState<string | null>(null)

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
  const groups = useMemo(() => {
    const out: { id: string; blocks: Block[] }[] = []
    for (const b of blocks) {
      const last = out[out.length - 1]
      if (last && last.id === b.groupId) last.blocks.push(b)
      else out.push({ id: b.groupId, blocks: [b] })
    }
    return out
  }, [blocks])
  const groupIds = useMemo(() => new Set(groups.map((g) => g.id)), [groups])
  const blockIds = useMemo(() => blocks.map((b) => b.id), [blocks])

  const collisionDetection: CollisionDetection = (args) => {
    const isGroupDrag = groupIds.has(String(args.active.id))
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (c) => groupIds.has(String(c.id)) === isGroupDrag,
      ),
    })
  }

  // Отклик блочного драга над ЧУЖОЙ мульти-группой: ring подсвечивает её границы —
  // видно, какой вопрос примет блок. Позицию вставки показывает сама нативная
  // анимация (строки расступаются), линия не нужна. Одиночки не подсвечиваем
  // (ring вокруг одной строки — шум без информации).
  let highlightGroupId: string | null = null
  if (dragBlockId && overBlockId) {
    const activeBlk = blocks.find((b) => b.id === dragBlockId)
    const overBlk = blocks.find((b) => b.id === overBlockId)
    if (activeBlk && overBlk && activeBlk.groupId !== overBlk.groupId) {
      const g = groups.find((x) => x.id === overBlk.groupId)
      if (g && g.blocks.length > 1) highlightGroupId = g.id
    }
  }

  // Дроп по слою: группа → перестановка групп, блок → перестановка блоков.
  function onDragEnd(e: DragEndEvent) {
    setDragBlockId(null)
    setOverBlockId(null)
    const { active, over } = e
    if (!over || active.id === over.id) return
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
    if (opts.seed) updateBlock(id, { text: opts.seed })
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
    // блока нет — полотно пустеет, каретка на заголовок (не в body).
    if ((cur.text ?? '') === '') {
      if (isCaptionType(cur.type)) removeGroup(id)
      else removeBlock(id)
      if (prev) engine.focusBlock(prev.id)
      else focusTitle()
    }
  }

  // Backspace на объектной остановке (§2.2/§2.4): удалить объект, каретка — в конец
  // предыдущей строки; её нет → заголовок формы.
  function handleDeleteObject(id: string) {
    const i = blocks.findIndex((b) => b.id === id)
    const prev = blocks[i - 1]
    removeBlock(id)
    if (prev) engine.focusBlock(prev.id, 'end')
    else focusTitle()
  }

  // Обход стрелками между строками (§2.1): вниз — в начало следующей, вверх — в конец
  // предыдущей; из первой строки вверх — заголовок формы. Край определяет, куда встанет
  // каретка у многострочных/составных целей (первый/последний вариант choice).
  function handleArrow(id: string, dir: 'up' | 'down') {
    const i = blocks.findIndex((b) => b.id === id)
    const neighbor = dir === 'up' ? blocks[i - 1] : blocks[i + 1]
    if (neighbor) engine.focusBlock(neighbor.id, dir === 'up' ? 'end' : 'start')
    else if (dir === 'up') focusTitle()
  }

  return (
    // Метрики холста = общий .rf-page (fields.css): десктоп 96/80/96, мобильный
    // 40/20/64 — тот же брейкпоинт (sm=640), чтобы редактор не разъезжался с
    // превью/рендерером на узком экране.
    <FocusEngineProvider value={engine}>
    <div className="mx-auto max-w-[860px] px-5 pb-16 pt-10 sm:px-20 sm:pb-24 sm:pt-24">
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
          onDragStart={(e) => {
            const id = String(e.active.id)
            setDragBlockId(groupIds.has(id) ? null : id)
          }}
          onDragOver={(e) => {
            const id = e.over ? String(e.over.id) : null
            setOverBlockId(id && !groupIds.has(id) ? id : null)
          }}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            setDragBlockId(null)
            setOverBlockId(null)
          }}
        >
          <SortableContext items={groups.map((g) => g.id)} strategy={verticalListSortingStrategy}>
            {/* Отступ заголовок→блоки и шаг между блоками держим равными ритму
                .rf-page/.rf-form у превью и респондента (32px и 20px). У блока
                свой py-1.5 (место под hover-контролы), поэтому здесь mt-7+6=34
                и gap-2+6+6=20, а не «на глаз» mt-8/gap-1.5: те давали 58px под
                заголовком против 32px в превью — редактор разъезжался с формой. */}
            <ol className="mt-7 flex flex-col gap-2">
              {groups.map((g) => (
                <GroupRow
                  key={g.id}
                  group={g}
                  formId={formId}
                  blockIds={blockIds}
                  highlight={g.id === highlightGroupId}
                  menuForId={menuForId}
                  onAddBelow={handleAddBelow}
                  onInsertBelow={handleInsertBelow}
                  onBackspaceAtStart={handleBackspaceAtStart}
                  onDeleteObject={handleDeleteObject}
                  onArrow={handleArrow}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}

      {blocks.length > 0 && (
        <button
          type="button"
          onClick={() => handleInsertBelow(blocks[blocks.length - 1]?.id ?? '')}
          className="mt-4 text-left text-sm text-muted-foreground hover:text-foreground"
        >
          + Добавить блок
        </button>
      )}

      <BlockTypeDialog open={insertOpen} onOpenChange={setInsertOpen} onPick={handlePickInsertType} />

      <SubmitButtonEditor />
    </div>
    </FocusEngineProvider>
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
// в SlashEditor). highlight — над группой тащат блок: ring показывает её границы.
function GroupRow({
  group,
  formId,
  blockIds,
  highlight,
  menuForId,
  onAddBelow,
  onInsertBelow,
  onBackspaceAtStart,
  onDeleteObject,
  onArrow,
}: {
  group: { id: string; blocks: Block[] }
  formId: string
  blockIds: string[]
  highlight: boolean
  menuForId: string | null
  onAddBelow: (id: string, opts?: { openMenu?: boolean; seed?: string; inside?: boolean }) => void
  onInsertBelow: (id: string) => void
  onBackspaceAtStart: (id: string) => void
  onDeleteObject: (id: string) => void
  onArrow: (id: string, dir: 'up' | 'down') => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.id,
    // Без «доигрывания» анимации после дропа (отскок к старой позиции) — см. dnd.ts.
    animateLayoutChanges: noLayoutAnimation,
  })
  // Translate-only (как у BlockRow): сдвиг без scaleY, чтобы группа не сжималась
  // под высоту соседнего слота при перетаскивании.
  const style = { transform: CSS.Translate.toString(transform), transition }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`rounded-md ${isDragging ? 'relative z-10 opacity-70' : ''} ${
        highlight ? 'ring-2 ring-primary/40' : ''
      }`}
    >
      <SortableContext items={blockIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">
          {group.blocks.map((b, i) => (
            <BlockRow
              key={b.id}
              block={b}
              formId={formId}
              groupHandle={
                group.blocks.length > 1 && i === 0 ? { attributes, listeners } : null
              }
              openMenuOnMount={menuForId === b.id}
              onAddBelow={onAddBelow}
              onInsertBelow={onInsertBelow}
              onBackspaceAtStart={onBackspaceAtStart}
              onDeleteObject={onDeleteObject}
              onArrow={onArrow}
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
    <div className="mt-10">
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
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter') {
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
      className="mt-7 cursor-text text-base leading-6 text-muted-foreground/60 outline-none"
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
function FormTitleInput({
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
  const lastSaved = useRef(initialTitle)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Дефолтное имя показываем пустым полем → виден плейсхолдер.
  const initialValue = initialTitle === DEFAULT_FORM_TITLE ? '' : initialTitle

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

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
    if (!trimmed || trimmed === lastSaved.current) return
    timer.current = setTimeout(() => {
      rename.mutate(
        { id: formId, title: trimmed },
        { onSuccess: () => (lastSaved.current = trimmed) },
      )
    }, 800)
  }

  // Enter/↓ — уйти на первый блок; Enter в заголовке не заводит перевод строки
  // (title однострочный логически, хоть и переносится визуально при отрисовке).
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
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
      placeholder="Название формы"
      aria-label="Название формы"
      // Название вне стора билдера (серверный rename) — Ctrl+Z здесь нативный,
      // document-undo билдера его не перехватывает (см. BuilderScreen).
      data-undo-native
      // mb-0: отступ заголовок→блоки целиком задаёт mt-7 у списка блоков (см.
      // коммент там). Прежние mb-5 + mt-8 складывались в 52px против 32px в превью.
      className="rf-title w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-muted-foreground/40"
    />
  )
}
