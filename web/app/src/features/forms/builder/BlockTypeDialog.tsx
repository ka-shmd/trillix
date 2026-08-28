import { useMemo, useState } from 'react'
import { ArrowRight, Search } from 'lucide-react'
import {
  type Block,
  type BlockType,
  carriesText,
  isChoiceType,
  textFromString,
} from '@entities/formSchema'
import { BlockField } from '@fields/BlockField'
import { BLOCK_GROUP_LABELS, BLOCK_GROUP_ORDER, MENU_ITEMS, type MenuItem } from './blockTypes'
import { editorKind, textIsBold } from './kinds/index'
import { applyDefaultMarks, BOLD_MARKS } from './richText'
import { chords } from './shortcuts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

// Полноценное модальное окно выбора типа блока — открывается кнопкой «+». Слева —
// типы по группам (Вопросы / Лэйаут), справа — описание активного типа и пример
// его вида (реальный блок, как в форме), сверху — поиск по названию.
export function BlockTypeDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (item: MenuItem) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl gap-0 overflow-hidden p-0 sm:max-w-4xl"
        // Как у SlashMenu: фокус после вставки ставит движок (handlePickInsertType →
        // engine.focusBlock), возврат фокуса Radix'ом на кнопку «+» глушим.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Добавить блок</DialogTitle>
        <DialogDescription className="sr-only">Выберите тип блока формы.</DialogDescription>
        {/* Тело — отдельный компонент внутри Content: Radix размонтирует его при
            закрытии, поэтому поиск/выбор сбрасываются к дефолту сами, без эффектов. */}
        <DialogBody onPick={onPick} />
      </DialogContent>
    </Dialog>
  )
}

function DialogBody({ onPick }: { onPick: (item: MenuItem) => void }) {
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string>(MENU_ITEMS[0]!.key)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? MENU_ITEMS.filter((b) => b.label.toLowerCase().includes(q)) : MENU_ITEMS
  }, [query])

  // Показываемый пункт: активный, если он в отфильтрованном списке, иначе первый
  // видимый. Производное значение — без синхронизации через эффект (setState в
  // эффекте под запретом линта).
  const shown = filtered.some((b) => b.key === activeKey) ? activeKey : filtered[0]?.key
  const activeMeta = MENU_ITEMS.find((b) => b.key === shown)

  return (
    <>
      <div className="flex items-center gap-2 border-b p-4 pr-14">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (chords.enter(e) && activeMeta) onPick(activeMeta)
            }}
            placeholder="Поиск по названию…"
            className="pl-8"
          />
        </div>
        <Button
          type="button"
          onClick={() => activeMeta && onPick(activeMeta)}
          disabled={!activeMeta}
          className="shrink-0"
        >
          Добавить <ArrowRight className="size-4" />
        </Button>
      </div>

      <div className="flex h-[34rem]">
        {/* Левая часть: типы по группам. */}
        <div className="w-64 shrink-0 overflow-y-auto border-r p-2">
          {BLOCK_GROUP_ORDER.map((g) => {
            const items = filtered.filter((b) => b.group === g)
            if (items.length === 0) return null
            return (
              // role+aria-label: группа была только визуальной (заголовок текстом),
              // программно список выглядел россыпью кнопок без деления — скринридер
              // не отличал «Шкалу с заголовком» от «голой Шкалы». Тот же тип поля
              // намеренно присутствует в двух группах, поэтому имя группы — часть
              // смысла пункта, а не оформление.
              <div key={g} className="mb-2" role="group" aria-label={BLOCK_GROUP_LABELS[g]}>
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {BLOCK_GROUP_LABELS[g]}
                </div>
                {items.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => setActiveKey(b.key)}
                    onDoubleClick={() => onPick(b)}
                    onFocus={() => setActiveKey(b.key)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                      shown === b.key ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                    }`}
                  >
                    <span className="text-muted-foreground">{b.icon}</span>
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

        {/* Правая часть: описание (сверху) и пример (снизу), разделённые бордером. */}
        <div className="flex flex-1 flex-col overflow-y-auto">
          {activeMeta && (
            <>
              <div className="p-4">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{activeMeta.icon}</span>
                  <h3 className="text-base font-semibold">{activeMeta.label}</h3>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{activeMeta.description}</p>
              </div>

              <div className="border-t p-4">
                <div className="mb-2 text-xs text-muted-foreground">
                  Пример
                </div>
                <BlockField block={sampleBlock(activeMeta.type)} captionText="Ваш вопрос" />
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

// sampleBlock — образец блока для превью: реальный @fields/BlockField рисует его
// как увидит респондент. choice получает пару вариантов, text — абзац-пример.
function sampleBlock(type: BlockType): Block {
  const text = carriesText(type)
    ? type === 'text'
      ? 'Пример пояснительного текста для респондента.'
      : type.startsWith('heading')
        ? editorKind(type).label
        : type === 'consent'
          ? 'Соглашаюсь с условиями'
          : 'Ваш вопрос'
    : ''
  const base: Block = {
    id: 'sample',
    groupId: 'sample',
    type,
    // Жирность заголовков и подписей живёт в ТЕКСТЕ (марка `b`), поэтому образец обязан
    // её нести: без марки картинка обещала бы обычный вес, а вставленный блок оказался
    // бы жирным — то есть образец врал бы ровно про то, ради чего его и смотрят.
    text: applyDefaultMarks(textFromString(text), textIsBold(type) ? BOLD_MARKS : []),
  }
  if (isChoiceType(type)) {
    return {
      ...base,
      settings: {
        options: [
          { id: 's1', label: 'Вариант 1' },
          { id: 's2', label: 'Вариант 2' },
        ],
      },
    }
  }
  return base
}
