import { useState, type ReactNode } from 'react'
import { Asterisk, Copy, Replace, Trash2 } from 'lucide-react'
import { type Block, isCaptionType } from '@entities/formSchema'
import { BLOCK_GROUP_LABELS, BLOCK_GROUP_ORDER, MENU_ITEMS, type MenuItem } from './blockTypes'
import { typeIcons } from './blockTypeIcons'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

// BlockActionMenu — меню действий блока (Cmd+. §3.3). Маленький поповер у строки,
// Command-список как у слеш-меню — закрывает клавиатурные пробелы, для которых нет
// отдельных шорткатов: обязательность (мышью доступна только через звёздочку),
// дублирование (в сторе есть, UI не было), удаление, смена типа. Пункта ширины здесь
// НЕТ и не будет (спека §5, фаза 13.6): половинность не переключается, она возникает
// от соседства — вход только жест и Mod+Alt+←/→. Два вида в одном поповере:
// «действия» и подменю «сменить тип» (тот же список типов, что «+»-диалог и слеш-меню).
export function BlockActionMenu({
  open,
  onOpenChange,
  block,
  anchor,
  requiredFor,
  onToggleRequired,
  onDuplicate,
  onDelete,
  onPickType,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  block: Block
  // anchor — элемент, к которому Radix привязывает поповер (позиционированный span
  // в absolute-поле строки); asChild измеряет его.
  anchor: ReactNode
  // requiredFor — блок, чью обязательность правит пункт меню (см. BlockRow): у поля
  // это оно само, у подписи — поле её вопроса, у контента — ничего, и пункта нет.
  requiredFor?: Block
  onToggleRequired: () => void
  onDuplicate: () => void
  onDelete: () => void
  onPickType: (item: MenuItem) => void
}) {
  // Какой вид показан: действия или выбор нового типа. Сбрасывается на «действия»
  // при закрытии, чтобы следующее открытие начиналось с корня.
  const [view, setView] = useState<'actions' | 'types'>('actions')
  const isGroup = isCaptionType(block.type)

  const close = () => {
    setView('actions')
    onOpenChange(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!o) setView('actions')
        onOpenChange(o)
      }}
    >
      <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      <PopoverContent
        className="w-60 p-0"
        align="start"
        side="bottom"
        // Фокус после действия ставит фокус-движок/само действие; возврат Radix на
        // якорь (позиционированный span) глушим — иначе каретка падает в body.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {view === 'actions' ? (
          <Command>
            <CommandList>
              <CommandGroup>
                {requiredFor && (
                  <CommandItem
                    onSelect={() => {
                      onToggleRequired()
                      close()
                    }}
                  >
                    <Asterisk className="size-4" />
                    {requiredFor.required ? 'Убрать обязательность' : 'Сделать обязательным'}
                  </CommandItem>
                )}
                <CommandItem onSelect={() => setView('types')}>
                  <Replace className="size-4" />
                  Сменить тип
                </CommandItem>
                <CommandItem
                  onSelect={() => {
                    onDuplicate()
                    close()
                  }}
                >
                  <Copy className="size-4" />
                  Дублировать
                </CommandItem>
                <CommandItem
                  onSelect={() => {
                    onDelete()
                    close()
                  }}
                >
                  <Trash2 className="size-4" />
                  {isGroup ? 'Удалить вопрос' : 'Удалить блок'}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        ) : (
          <Command>
            <CommandInput placeholder="Тип поля…" />
            <CommandList>
              <CommandEmpty>Ничего не найдено</CommandEmpty>
              {BLOCK_GROUP_ORDER.map((g) => (
                <CommandGroup key={g} heading={BLOCK_GROUP_LABELS[g]}>
                  {MENU_ITEMS.filter((t) => t.group === g).map((t) => (
                    <CommandItem
                      key={t.key}
                      value={`${t.label} ${t.key}`}
                      onSelect={() => {
                        onPickType(t)
                        close()
                      }}
                    >
                      {typeIcons[t.type]}
                      {t.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
