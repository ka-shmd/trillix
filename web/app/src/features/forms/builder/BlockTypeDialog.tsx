import { useMemo, useState } from 'react'
import { ArrowRight, Search, X } from 'lucide-react'
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
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

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
        showCloseButton={false}
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

// Тонкая полоса прокрутки: 6px жёлоба вместо штатных 10 и бегунок тоном подписи на
// трети силы — штатный `bg-border` на белом почти не виден. Задано селектором потомка
// ТЕМ ЖЕ data-slot, что у вендора: полоса рисуется внутри ScrollArea, класс ей снаружи
// не передать.
const THIN_SCROLL =
  '[&_[data-slot=scroll-area-scrollbar]]:w-1.5 [&_[data-slot=scroll-area-thumb]]:bg-muted-foreground/30'

export function DialogBody({ onPick }: { onPick: (item: MenuItem) => void }) {
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
    // Список — вендоренный Command: стрелки из поля поиска двигают выделенный пункт,
    // фокус остаётся в поле (клавиатуру cmdk слушает на корне, куда событие всплывает).
    //  • фильтр наш (shouldFilter={false}) — подстрока названия, как и до Command;
    //  • наведение выделение НЕ двигает (disablePointerSelection): превью справа
    //    сменялось бы по пути курсора к кнопке «Добавить», и вставлялся бы не тот тип;
    //  • клик выбирает пункт для превью, двойной клик и Enter — вставляют. Enter гасится
    //    в поле (preventDefault): иначе cmdk дёрнул бы onSelect пункта, а тот лишь выбирает.
    <Command
      shouldFilter={false}
      disablePointerSelection
      value={shown ?? ''}
      onValueChange={setActiveKey}
      className="rounded-none bg-transparent"
    >
      <div className="flex items-center gap-2 p-4">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (!chords.enter(e)) return
              e.preventDefault()
              if (activeMeta) onPick(activeMeta)
            }}
            placeholder="Поиск по названию…"
            aria-label="Поиск по названию"
            className="pl-8"
          />
        </div>
        <Button
          type="button"
          onClick={() => activeMeta && onPick(activeMeta)}
          disabled={!activeMeta}
          className="shrink-0"
        >
          Добавить <ArrowRight />
        </Button>
        {/* Крестик — в ряду шапки, по центру её высоты, а не штатный абсолют окна в
            углу: тот стоял на 16px от верха над рядом ростом 32 и читался съехавшим. */}
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground"
            aria-label="Закрыть"
          >
            <X className="size-4" />
          </Button>
        </DialogClose>
      </div>

      <div className="flex h-[34rem]">
        {/* Левая часть: типы по группам, без подложки и без линии (решение владельца
            2026-09-14). Прокрутка — вендоренный ScrollArea с тонкой полосой, а не
            системная: у той своя ширина и цвет в каждом браузере. Своей прокрутки у
            CommandList нет — стрелки cmdk доводят пункт до вида через scrollIntoView,
            и он находит ближайший прокручиваемый предок, то есть viewport. */}
        <ScrollArea className={cn('w-64 shrink-0', THIN_SCROLL)}>
        <CommandList className="max-h-none overflow-visible p-2">
          {BLOCK_GROUP_ORDER.map((g) => {
            const items = filtered.filter((b) => b.group === g)
            if (items.length === 0) return null
            return (
              // Группа с заголовком — не оформление: тот же тип поля намеренно стоит в
              // двух группах, и имя группы — часть смысла пункта. cmdk отдаёт его
              // скринридеру через role="group" + aria-labelledby на заголовок.
              <CommandGroup key={g} heading={BLOCK_GROUP_LABELS[g]} className="p-0">
                {items.map((b) => (
                  <CommandItem
                    key={b.key}
                    value={b.key}
                    onSelect={() => setActiveKey(b.key)}
                    onDoubleClick={() => onPick(b)}
                  >
                    <span className="text-muted-foreground">{b.icon}</span>
                    {b.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )
          })}
          {filtered.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">Ничего не найдено</p>
          )}
        </CommandList>
        </ScrollArea>

        {/* Правая часть: описание сверху и пример снизу — отбивкой, без линии. */}
        <ScrollArea className={cn('flex-1', THIN_SCROLL)}>
        <div className="flex flex-col gap-6 p-4">
          {activeMeta && (
            <>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{activeMeta.icon}</span>
                  <h3 className="text-base font-semibold">{activeMeta.label}</h3>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{activeMeta.description}</p>
              </div>

              <div>
                <div className="mb-2 text-xs text-muted-foreground">Пример</div>
                <BlockField block={sampleBlock(activeMeta.type)} captionText="Ваш вопрос" />
              </div>
            </>
          )}
        </div>
        </ScrollArea>
      </div>
    </Command>
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
