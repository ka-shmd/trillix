import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
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
import { Button } from '@/components/ui/button'
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
  const reorderBlocks = useBuilderStore((s) => s.reorderBlocks)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [menuForId, setMenuForId] = useState<string | null>(null)
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
    setFocusId(addBlockAfter(insertAfterId, type))
    setInsertOpen(false)
  }

  function handleBackspaceEmpty(id: string) {
    const i = blocks.findIndex((b) => b.id === id)
    const prev = blocks[i - 1]
    removeBlock(id)
    if (prev) setFocusId(prev.id)
  }

  function handleArrow(id: string, dir: 'up' | 'down') {
    const i = blocks.findIndex((b) => b.id === id)
    const neighbor = dir === 'up' ? blocks[i - 1] : blocks[i + 1]
    if (neighbor) setFocusId(neighbor.id)
  }

  return (
    <div className="mx-auto max-w-3xl px-20 py-14">
      <FormTitleInput formId={formId} initialTitle={initialTitle} onEnter={focusFirstOrCreate} />

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
                  total={blocks.length}
                  focusMe={focusId === b.id}
                  onFocusHandled={() => setFocusId(null)}
                  openMenuOnMount={menuForId === b.id}
                  onAddBelow={handleAddBelow}
                  onInsertBelow={handleInsertBelow}
                  onBackspaceEmpty={handleBackspaceEmpty}
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
          <Button type="button" size="lg" title="Нажмите, чтобы изменить текст кнопки">
            {label}
          </Button>
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
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])

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
      ref={ref}
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
}: {
  formId: string
  initialTitle: string
  onEnter: () => void
}) {
  const rename = useRenameForm()
  // Дефолтное имя показываем пустым полем → виден плейсхолдер.
  const [title, setTitle] = useState(initialTitle === DEFAULT_FORM_TITLE ? '' : initialTitle)
  const lastSaved = useRef(initialTitle)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  function onChange(value: string) {
    setTitle(value)
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

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault()
      onEnter()
    }
  }

  return (
    <input
      value={title}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder="Без названия"
      aria-label="Название формы"
      className="mb-4 w-full bg-transparent text-4xl font-bold tracking-tight outline-none placeholder:text-muted-foreground/40"
    />
  )
}
