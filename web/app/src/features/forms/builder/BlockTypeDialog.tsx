import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { type BlockType } from '@entities/formSchema'
import {
  BLOCK_GROUP_LABELS,
  BLOCK_GROUP_ORDER,
  BLOCK_TYPES,
} from './blockTypes'
import { typeIcons } from './blockTypeIcons'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

// Полноценное модальное окно выбора типа блока — открывается кнопкой «+». Слева —
// типы по группам (Вопросы / Лэйаут), справа — описание активного типа и пример
// его вида, сверху — поиск по названию. Выбор создаёт блок нужного типа.
export function BlockTypeDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (type: BlockType) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Добавить блок</DialogTitle>
        <DialogDescription className="sr-only">Выберите тип блока формы.</DialogDescription>
        {/* Тело — отдельный компонент внутри Content: Radix размонтирует его при
            закрытии, поэтому поиск/выбор сбрасываются к дефолту сами, без эффектов. */}
        <DialogBody onPick={onPick} />
      </DialogContent>
    </Dialog>
  )
}

function DialogBody({ onPick }: { onPick: (type: BlockType) => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<BlockType>(BLOCK_TYPES[0]!.type)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? BLOCK_TYPES.filter((b) => b.label.toLowerCase().includes(q)) : BLOCK_TYPES
  }, [query])

  // Показываемый тип: активный, если он в отфильтрованном списке, иначе первый
  // видимый. Производное значение — без синхронизации через эффект (setState в
  // эффекте под запретом линта).
  const shown = filtered.some((b) => b.type === active) ? active : filtered[0]?.type
  const activeMeta = BLOCK_TYPES.find((b) => b.type === shown)

  return (
    <>
      <div className="border-b p-3 pr-12">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по названию…"
            className="pl-8"
          />
        </div>
      </div>

      <div className="flex h-80">
        {/* Левая часть: типы по группам. */}
        <div className="w-56 shrink-0 overflow-y-auto border-r p-2">
          {BLOCK_GROUP_ORDER.map((g) => {
            const items = filtered.filter((b) => b.group === g)
            if (items.length === 0) return null
            return (
              <div key={g} className="mb-2">
                <div className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {BLOCK_GROUP_LABELS[g]}
                </div>
                {items.map((b) => (
                  <button
                    key={b.type}
                    type="button"
                    onClick={() => onPick(b.type)}
                    onMouseEnter={() => setActive(b.type)}
                    onFocus={() => setActive(b.type)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${
                      shown === b.type ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                    }`}
                  >
                    <span className="text-muted-foreground">{typeIcons[b.type]}</span>
                    {b.label}
                  </button>
                ))}
              </div>
            )
          })}
          {filtered.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">Ничего не найдено</p>
          )}
        </div>

        {/* Правая часть: описание активного типа + пример. */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeMeta && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{typeIcons[activeMeta.type]}</span>
                <h3 className="text-sm font-semibold">{activeMeta.label}</h3>
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">{activeMeta.description}</p>

              <div className="mt-4 rounded-lg border bg-muted/30 p-3">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Пример
                </div>
                <TypePreview type={activeMeta.type} />
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

// TypePreview — как блок выглядит у респондента: для вопроса заголовок + контрол,
// для text — абзац. Инертный (pointer-events-none) — это иллюстрация, не поле.
function TypePreview({ type }: { type: BlockType }) {
  if (type === 'text') {
    return <p className="text-sm">Пример пояснительного текста для респондента.</p>
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">Ваш вопрос</span>
      <FieldSample type={type} />
    </div>
  )
}

function FieldSample({ type }: { type: BlockType }) {
  const cls = 'pointer-events-none bg-background'
  switch (type) {
    case 'long_text':
      return <Textarea disabled rows={2} placeholder="Развёрнутый ответ" className={cls} />
    case 'email':
      return <Input disabled placeholder="you@example.com" className={cls} />
    case 'number':
      return <Input disabled placeholder="0" className={cls} />
    case 'date':
      return <Input disabled placeholder="дд.мм.гггг" className={cls} />
    case 'single_choice':
    case 'multi_choice':
      return (
        <div className="flex flex-col gap-1.5">
          {['Вариант 1', 'Вариант 2'].map((o) => (
            <span key={o} className="flex items-center gap-2 text-sm">
              <span
                className={`size-4 shrink-0 border border-muted-foreground/40 ${
                  type === 'single_choice' ? 'rounded-full' : 'rounded-[4px]'
                }`}
              />
              {o}
            </span>
          ))}
        </div>
      )
    case 'short_text':
    default:
      return <Input disabled placeholder="Короткий ответ" className={cls} />
  }
}
