import type { ReactNode } from 'react'
import {
  AlignLeft,
  Calendar,
  CheckSquare,
  CircleDot,
  Hash,
  Mail,
  Pilcrow,
  Type,
} from 'lucide-react'
import { type BlockType } from '@entities/formSchema'
import { BLOCK_TYPES } from './blockTypes'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

// Иконка на тип поля — визуальная опора в меню. Ключи покрывают все семь типов.
const typeIcons: Record<BlockType, ReactNode> = {
  text: <Pilcrow className="size-4" />,
  short_text: <Type className="size-4" />,
  long_text: <AlignLeft className="size-4" />,
  email: <Mail className="size-4" />,
  number: <Hash className="size-4" />,
  single_choice: <CircleDot className="size-4" />,
  multi_choice: <CheckSquare className="size-4" />,
  date: <Calendar className="size-4" />,
}

// Slash-меню выбора типа поля: Command-палитра в поповере, привязанном к строке
// блока. Открывается по «/» в пустом label или кнопкой «+». Выбор конвертирует
// текущий блок в поле нужного типа (changeBlockType).
export function SlashMenu({
  open,
  onOpenChange,
  onPick,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (type: BlockType) => void
  children: ReactNode
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent className="w-64 p-0" align="start" side="bottom">
        <Command>
          <CommandInput placeholder="Тип поля…" />
          <CommandList>
            <CommandEmpty>Ничего не найдено</CommandEmpty>
            <CommandGroup>
              {BLOCK_TYPES.map((t) => (
                <CommandItem key={t.type} value={t.label} onSelect={() => onPick(t.type)}>
                  {typeIcons[t.type]}
                  {t.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
