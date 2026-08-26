import * as React from 'react'
import { Label as LabelPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

// ЛОКАЛЬНАЯ ПРАВКА ВЕНДОРЕННОГО КОМПОНЕНТА: вес подписи поднят с medium до
// semibold (решение владельца). Переустановишь компонент из shadcn — вернётся
// medium, и подписи полей во всём кабинете похудеют разом.
// Значение — в таблице кеглей docs/DESIGN-SYSTEM.md.
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-semibold select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Label }
