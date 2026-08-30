import { useEffect, useRef, type ReactNode } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

// Источник подстановки, как его показывают в меню: вопрос и то имя, которым он зовётся
// в данных (заголовок колонки CSV, шаг воронки). Одно имя на все поверхности — автор не
// должен догадываться, что «Телефон» в выгрузке и «Телефон» в меню это один вопрос.
export interface MentionItem {
  id: string
  label: string
}

// MentionMenu — инлайн-меню подстановки ответа (docs/design/mentions.md §7). Устроено
// ровно как SlashMenu и по тем же причинам: «@» остаётся литералом в тексте, меню
// открывается поверх строки и фильтруется продолжением набора, поэтому своего поля
// ввода у него нет — список, подсветка и навигация приходят от строки (RichLine),
// которая читает набор с поверхности. Фокус меню не забирает: уйди он из строки, и
// каретка потерялась бы, а набор-фильтр прекратился.
//
// Отдельный компонент, а не проп у SlashMenu: списки разной природы (типы блоков против
// вопросов документа), и общего у них ровно оболочка поповера.
export function MentionMenu({
  open,
  items,
  activeIndex,
  onActiveChange,
  onPick,
  onClose,
  children,
}: {
  open: boolean
  items: readonly MentionItem[]
  activeIndex: number
  onActiveChange: (index: number) => void
  onPick: (item: MentionItem) => void
  onClose: () => void
  children: ReactNode
}) {
  const listRef = useRef<HTMLDivElement>(null)

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
        className="w-72 p-0"
        align="start"
        side="bottom"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div ref={listRef} role="listbox" className="max-h-72 overflow-y-auto p-1">
          {items.length === 0 ? (
            // Два разных «пусто» здесь намеренно НЕ различаются текстом: и «выше нет
            // вопросов», и «ни один не подошёл под фильтр» означают для автора одно —
            // подставить сюда нечего. Ссылаться вперёд нельзя (§4 спеки), и обещать это
            // отдельной фразой значило бы намекать, что где-то есть способ.
            <p className="px-2 py-4 text-sm text-muted-foreground">
              Нет вопросов выше — подставить можно только уже заданный ответ
            </p>
          ) : (
            items.map((item, i) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                data-index={i}
                // mousedown не должен уводить фокус из строки (иначе меню закроется до
                // клика) — гасим, клик по кнопке всё равно проходит.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => onActiveChange(i)}
                onClick={() => onPick(item)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                  i === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
              >
                <span className="truncate">{item.label}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
