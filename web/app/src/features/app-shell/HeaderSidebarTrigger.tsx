import { Separator } from '@/components/ui/separator'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'

// Кнопка панели в верхнем баре — ТОЛЬКО когда её негде нажать в самой панели.
//
// Свёрнутая панель при `collapsible=offcanvas` уезжает за экран целиком, унося
// свою кнопку; на мобильном панель и вовсе `Sheet`, который закрытым себя не
// показывает. В обоих случаях без кнопки в баре навигация недостижима. Развёрнутая
// панель на десктопе свою кнопку показывает сама — тогда в баре она лишняя.
//
// Свой компонент, а не условие в разметке маршрута: `useSidebar` читается только
// ВНУТРИ `SidebarProvider`, а маршрут `_app` этот провайдер как раз и рендерит.
export function HeaderSidebarTrigger() {
  const { state, isMobile } = useSidebar()
  // На мобильном `state` описывает десктопную панель и к шторке отношения не
  // имеет — там кнопка нужна всегда.
  if (!isMobile && state !== 'collapsed') return null

  return (
    <>
      <SidebarTrigger className="text-muted-foreground" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
    </>
  )
}
