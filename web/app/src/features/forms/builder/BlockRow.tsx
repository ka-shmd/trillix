import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Plus, Trash2, X } from 'lucide-react'
import {
  type Block,
  type BlockType,
  isChoiceType,
  isContentType,
  supportsPlaceholder,
} from '@entities/formSchema'
import { useBuilderStore } from './storeContext'
import { SlashMenu } from './SlashMenu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

// Автовысота textarea: строка вопроса растёт под контент, не заводя скролл.
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

export interface BlockRowProps {
  block: Block
  total: number
  // focusMe — редактор просит поставить фокус на label этой строки (после Enter/
  // удаления соседа/навигации стрелками). onFocusHandled сбрасывает запрос.
  focusMe: boolean
  onFocusHandled: () => void
  // openMenuOnMount — строку создали по «/» или «+»: сразу открыть меню выбора типа.
  openMenuOnMount: boolean
  // onAddBelow — Enter: новая текстовая строка без меню (продолжаем писать).
  onAddBelow: (id: string) => void
  // onInsertBelow — кнопка «+»: новая строка с открытым меню выбора типа.
  onInsertBelow: (id: string) => void
  onBackspaceEmpty: (id: string) => void
  onArrow: (id: string, dir: 'up' | 'down') => void
}

// BlockRow — одна строка полотна в стиле Tally: слева в поле — ручка перетаскивания
// (dnd) и «+», по центру редактируемый заголовок и живое превью поля, справа —
// меню действий и удаление. Клавиатура: Enter — новый блок, «/» — меню типов,
// Backspace в пустом — удалить и уйти на предыдущий, ↑/↓ на границе — переход,
// Alt+↑/↓ — перемещение.
export function BlockRow({
  block,
  total,
  focusMe,
  onFocusHandled,
  openMenuOnMount,
  onAddBelow,
  onInsertBelow,
  onBackspaceEmpty,
  onArrow,
}: BlockRowProps) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const moveBlock = useBuilderStore((s) => s.moveBlock)
  const removeBlock = useBuilderStore((s) => s.removeBlock)
  const changeBlockType = useBuilderStore((s) => s.changeBlockType)
  const labelRef = useRef<HTMLTextAreaElement>(null)
  // Строку создали по «/» → меню типов открыто с монтирования (без setState в эффекте).
  const [slashOpen, setSlashOpen] = useState(openMenuOnMount)
  const isContent = isContentType(block.type)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
  })
  const style = { transform: CSS.Transform.toString(transform), transition }

  useEffect(() => {
    if (!focusMe) return
    focusLabelEnd()
    onFocusHandled()
  }, [focusMe, onFocusHandled])

  useEffect(() => {
    autosize(labelRef.current)
  }, [block.label])

  function focusLabelEnd() {
    const el = labelRef.current
    if (!el) return
    el.focus()
    const len = el.value.length
    el.setSelectionRange(len, len)
  }

  function onLabelKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    if (e.key === 'Enter') {
      e.preventDefault()
      onAddBelow(block.id)
    } else if (e.key === '/' && block.label === '' && isContent) {
      // Тип выбирается только у ещё не выбранного (text) блока. У блока с уже
      // выбранным типом «/» не открывает меню — тип менять нельзя.
      e.preventDefault()
      setSlashOpen(true)
    } else if (
      e.key === 'Backspace' &&
      block.label === '' &&
      el.selectionStart === 0 &&
      total > 1
    ) {
      e.preventDefault()
      onBackspaceEmpty(block.id)
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      moveBlock(block.id, e.key === 'ArrowUp' ? 'up' : 'down')
    } else if (e.key === 'ArrowUp' && el.selectionStart === 0) {
      e.preventDefault()
      onArrow(block.id, 'up')
    } else if (e.key === 'ArrowDown' && el.selectionStart === el.value.length) {
      e.preventDefault()
      onArrow(block.id, 'down')
    }
  }

  function pickType(type: BlockType) {
    changeBlockType(block.id, type)
    setSlashOpen(false)
    requestAnimationFrame(focusLabelEnd)
  }

  const iconBtn =
    'flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground'

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`group relative rounded-md py-1.5 ${isDragging ? 'z-10 opacity-70' : ''}`}
    >
      {/* Все элементы управления — в левом поле (вне колонки текста, absolute), поэтому
          сам текст остаётся по центру колонки. Всегда видимы; h-8 + items-center и
          leading-8 у текста → значки на уровне строки. Порядок: удалить, добавить,
          перетащить. */}
      <div className="absolute right-full top-1.5 mr-1 flex h-8 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={() => removeBlock(block.id)}
          aria-label="Удалить блок"
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => onInsertBelow(block.id)}
          aria-label="Добавить блок ниже (выбрать тип)"
          className={iconBtn}
        >
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Перетащить блок"
          className={`${iconBtn} cursor-grab active:cursor-grabbing`}
        >
          <GripVertical className="size-4" />
        </button>
      </div>

      <SlashMenu open={slashOpen} onOpenChange={setSlashOpen} onPick={pickType}>
        <div className="min-w-0">
          <textarea
            ref={labelRef}
            rows={1}
            value={block.label}
            // Плейсхолдер показываем у любого пустого блока (в т.ч. неактивного),
            // чтобы пустая строка не выглядела «пропавшей». У вопроса «/» уже не
            // работает (тип выбран) — подсказку про слэш не показываем.
            placeholder={isContent ? 'Текст, или «/» для поля' : 'Введите текст вопроса'}
            onChange={(e) => updateBlock(block.id, { label: e.target.value })}
            onKeyDown={onLabelKeyDown}
            className={`w-full resize-none bg-transparent leading-8 outline-none placeholder:text-muted-foreground/60 ${
              isContent
                ? 'text-lg placeholder:font-normal'
                : 'text-xl font-semibold placeholder:font-semibold'
            }`}
          />

          {/* Text (неотвечаемый) — только абзац. Choice — варианты. Остальные
              (поля ввода) — редактируемое поле ответа с плейсхолдером. */}
          {isContent ? null : isChoiceType(block.type) ? (
            <OptionsInline block={block} onLeaveTop={focusLabelEnd} />
          ) : (
            <AnswerField block={block} />
          )}
        </div>
      </SlashMenu>
    </li>
  )
}

// AnswerField — поле ответа под вопросом. Для текстовых типов оно редактируемое:
// автор вводит сюда текст-плейсхолдер (settings.placeholder), который увидит
// респондент. date — статичное превью (в поле даты плейсхолдер не показывается).
function AnswerField({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const [focused, setFocused] = useState(false)
  const ph = block.settings?.placeholder ?? ''
  const setPh = (value: string) =>
    updateBlock(block.id, { settings: { ...block.settings, placeholder: value } })
  // Подсказку-хинт показываем только при фокусе (клике) на поле.
  const hint = focused ? 'Плейсхолдер ответа (необязательно)' : undefined
  const cls = 'mt-1.5 border-muted-foreground/30 text-base'

  if (!supportsPlaceholder(block.type)) {
    return (
      <Input
        type="date"
        disabled
        className="pointer-events-none mt-1.5 max-w-56 border-muted-foreground/30 bg-muted/30"
      />
    )
  }
  const focusProps = {
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  }
  if (block.type === 'long_text') {
    return (
      <Textarea
        value={ph}
        onChange={(e) => setPh(e.target.value)}
        rows={2}
        placeholder={hint}
        className={cls}
        {...focusProps}
      />
    )
  }
  return (
    <Input
      value={ph}
      onChange={(e) => setPh(e.target.value)}
      placeholder={hint}
      className={cls}
      {...focusProps}
    />
  )
}

// OptionsInline — варианты choice-блока строками прямо под вопросом, с глифом
// радио/чекбокса как у готового поля. Клавиатура: Enter — новый вариант (фокус на
// него), Backspace в пустом — удалить и уйти на предыдущий (или на заголовок).
function OptionsInline({ block, onLeaveTop }: { block: Block; onLeaveTop: () => void }) {
  const addOption = useBuilderStore((s) => s.addOption)
  const updateOption = useBuilderStore((s) => s.updateOption)
  const removeOption = useBuilderStore((s) => s.removeOption)
  const options = useMemo(() => block.settings?.options ?? [], [block.settings?.options])
  const optionRefs = useRef(new Map<string, HTMLInputElement | null>())
  // Запрос фокуса держим в ref, а не в state: после add/remove опций стор меняет
  // массив → эффект переставляет фокус, не вызывая лишний ре-рендер (setState в
  // эффекте под запретом линта). 'last' — на последнюю опцию (после Enter/добавления).
  const pendingFocus = useRef<string | 'last' | null>(null)

  useEffect(() => {
    const req = pendingFocus.current
    if (req === null) return
    const id = req === 'last' ? options[options.length - 1]?.id : req
    if (id) optionRefs.current.get(id)?.focus()
    pendingFocus.current = null
  }, [options])

  function onOptionKeyDown(e: KeyboardEvent<HTMLInputElement>, optionId: string, i: number) {
    if (e.key === 'Enter') {
      e.preventDefault()
      pendingFocus.current = 'last'
      addOption(block.id)
    } else if (e.key === 'Backspace' && e.currentTarget.value === '') {
      e.preventDefault()
      const prev = options[i - 1]
      removeOption(block.id, optionId)
      if (prev) pendingFocus.current = prev.id
      else onLeaveTop()
    }
  }

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {options.map((o, i) => (
        <div key={o.id} className="flex items-center gap-2">
          <span
            className={`size-4 shrink-0 border border-muted-foreground/40 ${
              block.type === 'single_choice' ? 'rounded-full' : 'rounded-[4px]'
            }`}
            aria-hidden="true"
          />
          <input
            ref={(el) => {
              optionRefs.current.set(o.id, el)
            }}
            value={o.label}
            placeholder={`Вариант ${i + 1}`}
            aria-label={`Вариант ${i + 1}`}
            onChange={(e) => updateOption(block.id, o.id, e.target.value)}
            onKeyDown={(e) => onOptionKeyDown(e, o.id, i)}
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={() => removeOption(block.id, o.id)}
            aria-label="Удалить вариант"
            className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          pendingFocus.current = 'last'
          addOption(block.id)
        }}
        className="flex w-fit items-center gap-2 text-base text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-4" /> Добавить вариант
      </button>
    </div>
  )
}
