import { EllipsisVertical, type LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Меню операций строки — значок `⋮` В КОНЦЕ строки, там, где раньше стоял крестик.
// Один компонент на оба яруса блока условия («Когда» и «Тогда»): состав пунктов у них
// разный, а вид, положение и клавиатура — один в один, и разъехаться им нельзя.
//
// Пункты приходят списком, а не флагами: у ярусов разное число операций (у условия есть
// «обернуть в группу», у действия её нет), и набор флагов пришлось бы расширять на
// каждое новое расхождение. Скрытый пункт — просто отсутствующий элемент списка.
export function RowMenu({
  label,
  items,
}: {
  // Чем меню называется скринридеру: «Действия с условием» / «Действия с действием»
  // различаются, потому что на одной строке блока их бывает два.
  label: string
  items: { icon: LucideIcon; label: string; onSelect: () => void }[]
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={label}>
          <EllipsisVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {items.map(({ icon: Icon, label: text, onSelect }) => (
          <DropdownMenuItem key={text} onSelect={onSelect}>
            <Icon className="size-4" />
            {text}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
