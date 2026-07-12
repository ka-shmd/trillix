import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, Trash2, X } from 'lucide-react'
import { type Block, type BlockType, isChoiceType } from '@entities/formSchema'
import { useBuilderStore } from './storeContext'
import { blockTypeLabel } from './blockTypes'
import { SlashMenu } from './SlashMenu'
import { Button } from '@/components/ui/button'

// Автовысота textarea: строка вопроса растёт под контент, не заводя скролл.
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

export interface BlockRowProps {
  block: Block
  index: number
  total: number
  // focusMe — редактор просит поставить фокус на label этой строки (после Enter/
  // удаления соседа/навигации стрелками). onFocusHandled сбрасывает запрос.
  focusMe: boolean
  onFocusHandled: () => void
  onEnter: (id: string) => void
  onBackspaceEmpty: (id: string) => void
  onArrow: (id: string, dir: 'up' | 'down') => void
}

// BlockRow — одна строка полотна: тип (slash-меню), редактируемый label и
// description, инлайн-опции для choice, тулбар (обязательность, перемещение,
// удаление). Клавиатура: Enter — новый блок, «/» — меню типов, Backspace в пустом
// — удалить и уйти на предыдущий, ↑/↓ на границе — переход, Alt+↑/↓ — перемещение.
export function BlockRow({
  block,
  index,
  total,
  focusMe,
  onFocusHandled,
  onEnter,
  onBackspaceEmpty,
  onArrow,
}: BlockRowProps) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const moveBlock = useBuilderStore((s) => s.moveBlock)
  const removeBlock = useBuilderStore((s) => s.removeBlock)
  const changeBlockType = useBuilderStore((s) => s.changeBlockType)
  const labelRef = useRef<HTMLTextAreaElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!focusMe) return
    const el = labelRef.current
    if (el) {
      el.focus()
      const len = el.value.length
      el.setSelectionRange(len, len)
    }
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
      onEnter(block.id)
    } else if (e.key === '/' && block.label === '') {
      e.preventDefault()
      setMenuOpen(true)
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
    setMenuOpen(false)
    requestAnimationFrame(focusLabelEnd)
  }

  return (
    <li className="group relative rounded-lg border border-transparent px-2 py-2 transition-colors hover:border-border hover:bg-muted/30 focus-within:border-border">
      <div className="flex items-start gap-2">
        <SlashMenu open={menuOpen} onOpenChange={setMenuOpen} onPick={pickType}>
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="mt-1 shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted"
            title="Сменить тип (или «/» в пустой строке)"
          >
            {blockTypeLabel(block.type)}
          </button>
        </SlashMenu>

        <div className="min-w-0 flex-1">
          <textarea
            ref={labelRef}
            rows={1}
            value={block.label}
            placeholder="Вопрос — впишите текст или «/» для выбора типа"
            onChange={(e) => updateBlock(block.id, { label: e.target.value })}
            onKeyDown={onLabelKeyDown}
            className="w-full resize-none bg-transparent text-base font-medium leading-snug outline-none placeholder:font-normal placeholder:text-muted-foreground"
          />
          <textarea
            rows={1}
            value={block.description ?? ''}
            placeholder="Описание (необязательно)"
            onChange={(e) => updateBlock(block.id, { description: e.target.value })}
            onInput={(e) => autosize(e.currentTarget)}
            className="w-full resize-none bg-transparent text-sm leading-snug text-muted-foreground outline-none"
          />
          {isChoiceType(block.type) && <OptionsInline block={block} onLeaveTop={focusLabelEnd} />}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <label className="mr-1 flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={block.required ?? false}
              onChange={(e) => updateBlock(block.id, { required: e.target.checked })}
            />
            Обяз.
          </label>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={index === 0}
            onClick={() => moveBlock(block.id, 'up')}
            aria-label="Переместить вверх"
          >
            <ChevronUp className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={index === total - 1}
            onClick={() => moveBlock(block.id, 'down')}
            aria-label="Переместить вниз"
          >
            <ChevronDown className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-destructive"
            onClick={() => removeBlock(block.id)}
            aria-label="Удалить блок"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
    </li>
  )
}

// OptionsInline — варианты choice-блока строками прямо под вопросом. Клавиатура:
// Enter — новый вариант (фокус на него), Backspace в пустом — удалить и уйти на
// предыдущий вариант (или на label, если это был первый).
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
    <div className="mt-1.5 flex flex-col gap-1">
      {options.map((o, i) => (
        <div key={o.id} className="flex items-center gap-1.5">
          <span
            className={`size-3.5 shrink-0 border border-muted-foreground/50 ${
              block.type === 'single_choice' ? 'rounded-full' : 'rounded-[3px]'
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
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={() => removeOption(block.id, o.id)}
            aria-label="Удалить вариант"
            className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
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
        className="w-fit pl-5 text-left text-sm text-muted-foreground hover:text-foreground"
      >
        + Добавить вариант
      </button>
    </div>
  )
}
