'use client'

import * as React from 'react'
import { XIcon } from 'lucide-react'
import { Dialog as SheetPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

// Анимация выезда — у сторон, но НЕ у стороны `full` (наша добавка, см. ниже): она
// уехала из базовых классов в каждую ветку именно поэтому. `full` обязана обходиться
// БЕЗ `animate-out`, а не с нулевой длительностью: Radix снимает содержимое по
// событию `animationend`, и анимация с именем, но без времени — лишняя ставка на то,
// что браузер это событие всё-таки пришлёт.
const SLIDE_ANIMATION =
  'data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:animate-in data-[state=open]:duration-500'

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  // showOverlay — наша добавка к вендоренному компоненту (фаза 22). Затемнение
  // предполагает, что шторка забирает внимание целиком, но у панели оформления
  // задача обратная: автор смотрит НЕ на неё, а на полотно за ней — тема меняется
  // у него на глазах. Затемнённое полотно этот смысл убивает.
  showOverlay = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  // 'full' — наша добавка к вендоренному компоненту: слой во весь вьюпорт, который не
  // выезжает, а появляется (полноэкранный просмотр формы, PreviewOverlay). Значением
  // варианта, а не перебивкой классов снаружи: ветки здесь взаимно исключающие, а
  // перебивка `slide-in-from-bottom` чужим классом решалась бы порядком правил в
  // собранном CSS — то есть молча и не в нашу пользу.
  side?: 'top' | 'right' | 'bottom' | 'left' | 'full'
  showCloseButton?: boolean
  showOverlay?: boolean
}) {
  return (
    <SheetPortal>
      {showOverlay && <SheetOverlay />}
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed z-50 flex flex-col gap-4 bg-background shadow-lg transition ease-in-out',
          side === 'right' &&
            `inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm ${SLIDE_ANIMATION}`,
          side === 'left' &&
            `inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm ${SLIDE_ANIMATION}`,
          side === 'top' &&
            `inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top ${SLIDE_ANIMATION}`,
          side === 'bottom' &&
            `inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom ${SLIDE_ANIMATION}`,
          side === 'full' && 'inset-0 h-dvh w-full border-0',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-secondary">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1.5 p-4', className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-semibold text-foreground', className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
