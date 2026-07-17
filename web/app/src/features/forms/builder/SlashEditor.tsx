import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { type BlockType, DEFAULT_SUBMIT_LABEL, MAX_SUBMIT_LABEL_LEN } from '@entities/formSchema'
import { useBuilderStore } from './storeContext'
import { BlockRow } from './BlockRow'
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
// редактируемые строки. Фокусом между строками управляет focusId; menuForId просит
// свежесозданную строку открыть меню типов (вставка блока по «/»). Стор, автосейв
// и превью — прежние; переписана только поверхность ввода.
export function SlashEditor({ formId, initialTitle }: { formId: string; initialTitle: string }) {
  const blocks = useBuilderStore((s) => s.blocks)
  const addBlockAfter = useBuilderStore((s) => s.addBlockAfter)
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const removeBlock = useBuilderStore((s) => s.removeBlock)
  const changeBlockType = useBuilderStore((s) => s.changeBlockType)
  const reorderBlocks = useBuilderStore((s) => s.reorderBlocks)
  const [focusId, setFocusId] = useState<string | null>(null)
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

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (over && active.id !== over.id) reorderBlocks(String(active.id), String(over.id))
  }

  // Создаёт новую строку (тип text): опционально засевает первый символ и просит
  // открыть меню типов. Возвращает фокус на неё.
  function startBlock(afterId: string | null, opts: { openMenu?: boolean; seed?: string } = {}) {
    const id = addBlockAfter(afterId, DEFAULT_BLOCK_TYPE)
    if (opts.seed) updateBlock(id, { label: opts.seed })
    if (opts.openMenu) setMenuForId(id)
    setFocusId(id)
  }

  function focusFirstOrCreate() {
    const first = blocks[0]
    if (first) setFocusId(first.id)
    else startBlock(null)
  }

  function handleAddBelow(id: string) {
    startBlock(id)
  }

  // Кнопка «+»: открыть диалог выбора типа блока (после блока id).
  function handleInsertBelow(id: string) {
    setInsertAfterId(id)
    setInsertOpen(true)
  }

  // Выбор типа в диалоге: создать блок этого типа на нужной позиции.
  function handlePickInsertType(type: BlockType) {
    const id = addBlockAfter(insertAfterId, type)
    // image без редактируемого заголовка не на что фокусировать — открываем новую
    // текстовую строку ниже (как в slash-потоке), чтобы каретка не пропала.
    if (type === 'image') startBlock(id)
    else setFocusId(id)
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
      if (cur.label === '' && cur.type !== 'text') changeBlockType(cur.id, 'text')
      return
    }
    // Пустой блок схлопываем в предыдущий (фокус в его конец). Предыдущего нет —
    // удаляем последний блок вовсе: форма пустеет, а каретку переносим на заголовок
    // (иначе фокус потерялся бы в body и печатать было бы некуда).
    if (cur.label === '') {
      removeBlock(id)
      if (prev) setFocusId(prev.id)
      else {
        // Заголовок всегда смонтирован (над полотном), поэтому фокусируем его сразу —
        // ре-рендер пустого полотна его не размонтирует, каретка сохранится. rAF тут
        // не нужен (нет Radix-возврата фокуса) и в фоновой вкладке не сработал бы.
        const el = titleRef.current
        if (el) {
          el.focus()
          el.setSelectionRange(el.value.length, el.value.length)
        }
      }
    }
  }

  function handleArrow(id: string, dir: 'up' | 'down') {
    const i = blocks.findIndex((b) => b.id === id)
    const neighbor = dir === 'up' ? blocks[i - 1] : blocks[i + 1]
    if (neighbor) setFocusId(neighbor.id)
  }

  return (
    // Метрики холста = общий .rf-page (fields.css): десктоп 144/80/96, мобильный
    // 40/20/64 — тот же брейкпоинт (sm=640), чтобы редактор не разъезжался с
    // превью/рендерером на узком экране.
    <div className="mx-auto max-w-3xl px-5 pb-16 pt-10 sm:px-20 sm:pb-24 sm:pt-36">
      <FormTitleInput
        formId={formId}
        initialTitle={initialTitle}
        onEnter={focusFirstOrCreate}
        titleRef={titleRef}
      />

      {blocks.length === 0 ? (
        <EmptyStarter onStart={(opts) => startBlock(null, opts)} />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={blocks.map((b) => b.id)}
            strategy={verticalListSortingStrategy}
          >
            <ol className="mt-8 flex flex-col gap-1.5">
              {blocks.map((b) => (
                <BlockRow
                  key={b.id}
                  block={b}
                  formId={formId}
                  focusMe={focusId === b.id}
                  onFocusHandled={() => setFocusId(null)}
                  openMenuOnMount={menuForId === b.id}
                  onAddBelow={handleAddBelow}
                  onInsertBelow={handleInsertBelow}
                  onBackspaceAtStart={handleBackspaceAtStart}
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
      className="mt-8 cursor-text text-lg leading-relaxed text-muted-foreground/60 outline-none"
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
      className="rf-title mb-5 w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-muted-foreground/40"
    />
  )
}
