import { useEffect, useRef, type ReactNode } from 'react'
import { BLOCK_GROUP_LABELS, type MenuItem } from './blockTypes'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

// SlashMenu — инлайн-меню выбора типа поля (§3.5, TD-33). Открывается по «/» прямо в
// тексте строки (литерал остаётся в тексте, каретка НЕ уходит из textarea) и
// фильтруется продолжением набора. Поэтому у меню НЕТ своего поля ввода: список
// (items), подсветка (activeIndex) и навигация приходят от родителя (BlockRow),
// который читает набор из самой строки. Клик по пункту — onPick; мышь наводит
// подсветку через onActiveChange. Позиционируется поповером у якоря (обёртки
// textarea), фокус не перехватывает (иначе каретка покинула бы строку).
export function SlashMenu({
  open,
  items,
  activeIndex,
  onActiveChange,
  onPick,
  onClose,
  children,
}: {
  open: boolean
  // items — уже отфильтрованный плоский список (в порядке MENU_ITEMS): индекс пункта
  // здесь = activeIndex клавиатурной навигации у родителя.
  items: MenuItem[]
  activeIndex: number
  onActiveChange: (index: number) => void
  onPick: (item: MenuItem) => void
  onClose: () => void
  children: ReactNode
}) {
  const listRef = useRef<HTMLDivElement>(null)

  // Активный пункт держим в поле зрения при навигации стрелками (фокуса в списке нет,
  // нативного скролла-к-фокусу тоже — доводим руками).
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  return (
    <Popover open={open} onOpenChange={(o) => !o && onClose()}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        className="w-64 p-0"
        align="start"
        side="bottom"
        // Меню — надстройка над печатью в строке: фокус обязан остаться в textarea, а
        // не прыгнуть в поповер (иначе каретка теряется, набор-фильтр не идёт). Глушим
        // и авто-фокус при открытии, и возврат при закрытии.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div ref={listRef} role="listbox" className="max-h-72 overflow-y-auto p-1">
          {items.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">Ничего не найдено</p>
          ) : (
            items.map((item, i) => {
              const heading = i === 0 || items[i - 1]!.group !== item.group
              return (
                <div key={item.key}>
                  {heading && (
                    <div className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {BLOCK_GROUP_LABELS[item.group]}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === activeIndex}
                    data-index={i}
                    // mousedown не должен уводить фокус из textarea (иначе меню
                    // закроется до клика) — гасим, клик по кнопке всё равно проходит.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => onActiveChange(i)}
                    onClick={() => onPick(item)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${
                      i === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                    }`}
                  >
                    <span className="text-muted-foreground">{item.icon}</span>
                    {item.label}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
