import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

// НАШИ ПРАВКИ (переустановка компонента из shadcn их сотрёт):
//
// 1. Выключенная дорожка красится `--switch-off`, а не `bg-input` — на линии полей
//    выключенный тумблер читался задизейбленным (index.css, у токена).
//
// 2. ГЕОМЕТРИЯ В ЦЕЛЫХ ПИКСЕЛЯХ. У shadcn дорожка `h-[1.15rem]` = 18.4px, и браузер
//    округлял её по-разному в зависимости от места на странице: бегунок, стоявший
//    впритык к краям, получал сверху и снизу 1 и 2px и выглядел кривым. Здесь дорожка
//    32×18, прозрачная рамка 2px (фон под ней красится — это поле вокруг бегунка),
//    внутри 28×14, бегунок 14. МИНА: ход бегунка — это внутренняя ширина минус
//    бегунок, 28 − 14 = 14px (`translate-x-3.5`). Меняешь любой из трёх размеров —
//    пересчитай ход, иначе бегунок не доедет до края или вылезет за него.
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-4.5 w-8 shrink-0 items-center rounded-full border-2 border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-switch-off',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-3.5 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
