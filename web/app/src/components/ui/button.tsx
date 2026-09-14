import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/utils'

// ЛОКАЛЬНАЯ ПРАВКА ГЕОМЕТРИИ (решение владельца 2026-09-14): радиус 8 (`rounded-lg`, он же
// `--radius`), вес 600, высоты на ступень ниже штатных shadcn — 32 обычная, 28 малая, 36
// крупная — при полях 12 / 10 / 16. Высоты зеркалят `Input` и `SelectTrigger`: ряд «поле +
// кнопка» обязан совпадать краями. Переустановишь компонент — правка пропадёт.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        // ЛОКАЛЬНЫЙ ВАРИАНТ, которого нет у shadcn: утилитарное действие рядом с
        // полем (копировать, скачать). Чёрным, а не акцентом — акцент значит
        // «главное действие экрана», и на «Копировать» он спорил бы с ним за внимание.
        // Свой токен `--utility`, а не `--foreground`: чернила текста и чёрное
        // заливки — разные роли, и связав их, правка текста меняла бы кнопки.
        // Отрыв от акцента замерен: 4.0:1 в светлой теме, 4.65:1 в тёмной.
        // Переустановишь компонент — вариант пропадёт вместе с правкой.
        utility: 'bg-utility text-utility-foreground hover:bg-utility/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-3 py-1.5 has-[>svg]:px-2.5',
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-7 gap-1.5 px-2.5 has-[>svg]:px-2',
        lg: 'h-9 px-4 has-[>svg]:px-3',
        icon: 'size-8',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-7',
        'icon-lg': 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
