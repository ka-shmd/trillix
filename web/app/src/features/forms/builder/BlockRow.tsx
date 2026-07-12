import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Copy, GripVertical, Plus, Trash2, X } from 'lucide-react'
import { type Block, type BlockType, isChoiceType, isContentType } from '@entities/formSchema'
import { useBuilderStore } from './storeContext'
import { SlashMenu } from './SlashMenu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

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
  // openMenuOnMount — строку создали по «/»: сразу открыть меню выбора типа.
  openMenuOnMount: boolean
  onAddBelow: (id: string) => void
  onBackspaceEmpty: (id: string) => void
  onArrow: (id: string, dir: 'up' | 'down') => void
}

// BlockRow — одна строка полотна в стиле Tally: редактируемый заголовок вопроса и
// под ним живое превью настоящего поля (для choice — редактируемые варианты).
// Управление блоком спрятано в левый gutter (появляется по наведению): «+» —
// добавить ниже, ручка-хват — меню (тип/дубль/перемещение/обязательность/удаление).
// Клавиатура: Enter — новый блок, «/» — меню типов, Backspace в пустом — удалить и
// уйти на предыдущий, ↑/↓ на границе — переход, Alt+↑/↓ — перемещение.
export function BlockRow({
  block,
  index,
  total,
  focusMe,
  onFocusHandled,
  openMenuOnMount,
  onAddBelow,
  onBackspaceEmpty,
  onArrow,
}: BlockRowProps) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const moveBlock = useBuilderStore((s) => s.moveBlock)
  const removeBlock = useBuilderStore((s) => s.removeBlock)
  const duplicateBlock = useBuilderStore((s) => s.duplicateBlock)
  const changeBlockType = useBuilderStore((s) => s.changeBlockType)
  const labelRef = useRef<HTMLTextAreaElement>(null)
  // Строку создали по «/» → меню типов открыто с монтирования (без setState в эффекте).
  const [slashOpen, setSlashOpen] = useState(openMenuOnMount)
  const [focused, setFocused] = useState(false)
  const isContent = isContentType(block.type)

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
    } else if (e.key === '/' && block.label === '') {
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

  return (
    <li className="group relative rounded-md py-1.5 pl-9 pr-2 transition-colors hover:bg-muted/40 focus-within:bg-muted/40">
      {/* Левый gutter: появляется по наведению, живёт в отступе pl-9. */}
      <div className="absolute left-0 top-2 flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={() => onAddBelow(block.id)}
          aria-label="Добавить вопрос ниже"
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Действия с блоком"
              className="flex size-6 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <GripVertical className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onSelect={() => setSlashOpen(true)}>Сменить тип поля</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => duplicateBlock(block.id)}>
              <Copy className="size-4" /> Дублировать
            </DropdownMenuItem>
            <DropdownMenuItem disabled={index === 0} onSelect={() => moveBlock(block.id, 'up')}>
              Переместить вверх
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index === total - 1}
              onSelect={() => moveBlock(block.id, 'down')}
            >
              Переместить вниз
            </DropdownMenuItem>
            {!isContent && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={block.required ?? false}
                  onCheckedChange={(v) => updateBlock(block.id, { required: v })}
                >
                  Обязательный
                </DropdownMenuCheckboxItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => removeBlock(block.id)}>
              <Trash2 className="size-4" /> Удалить
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <SlashMenu open={slashOpen} onOpenChange={setSlashOpen} onPick={pickType}>
        <div className="min-w-0">
          <div className="flex items-start gap-1">
            <textarea
              ref={labelRef}
              rows={1}
              value={block.label}
              // Плейсхолдер — только у активной строки: незанятый блок выглядит
              // пустой строкой с кареткой (как в Notion/Tally), без подсказок.
              placeholder={
                focused ? (isContent ? 'Текст, или «/» для поля' : 'Вопрос, или «/» для типа') : undefined
              }
              onChange={(e) => updateBlock(block.id, { label: e.target.value })}
              onKeyDown={onLabelKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              className={`w-full resize-none bg-transparent leading-snug outline-none placeholder:font-normal placeholder:text-muted-foreground/60 ${
                isContent ? 'text-base' : 'text-base font-medium'
              }`}
            />
            {!isContent && block.required && (
              <span className="mt-1 select-none text-base text-destructive" title="Обязательный">
                *
              </span>
            )}
          </div>

          {/* Живое превью поля показываем, только когда у вопроса есть текст:
              пустой блок = просто строка с кареткой. Choice всегда показывает
              варианты — тип выбран осознанно. Text (неотвечаемый) — только абзац. */}
          {isContent ? null : isChoiceType(block.type) ? (
            <OptionsInline block={block} onLeaveTop={focusLabelEnd} />
          ) : block.label.trim() !== '' ? (
            <FieldPreview type={block.type} />
          ) : null}
        </div>
      </SlashMenu>
    </li>
  )
}

// FieldPreview — как поле увидит респондент: инертный (disabled) контрол под
// заголовком. Даёт tally-ощущение «редактор = форма», не будучи интерактивным.
function FieldPreview({ type }: { type: BlockType }) {
  const cls = 'pointer-events-none mt-1.5 bg-muted/40'
  switch (type) {
    case 'long_text':
      return <Textarea disabled rows={2} placeholder="Развёрнутый ответ" className={cls} />
    case 'email':
      return <Input disabled placeholder="you@example.com" className={cls} />
    case 'number':
      return <Input disabled placeholder="0" className={cls} />
    case 'date':
      return <Input disabled placeholder="дд.мм.гггг" className={cls} />
    case 'short_text':
    default:
      return <Input disabled placeholder="Короткий ответ" className={cls} />
  }
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
    <div className="mt-2 flex flex-col gap-1.5">
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
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
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
        className="flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-4" /> Добавить вариант
      </button>
    </div>
  )
}
