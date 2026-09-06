import { Separator } from '@/components/ui/separator'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'

// Кнопка панели в верхнем баре — ТОЛЬКО когда её негде нажать в самой панели, то
// есть только на мобильном: там панель это `Sheet`, а закрытая шторка себя не
// показывает.
//
// На десктопе панель не уезжает за экран ни в одном состоянии (`collapsible=icon`):
// свёрнутая остаётся полосой значков вместе со своей кнопкой, поэтому вторая кнопка
// в баре была бы вторым органом с той же работой.
//
// Свой компонент, а не условие в разметке маршрута: `useSidebar` читается только
// ВНУТРИ `SidebarProvider`, а маршрут `_app` этот провайдер как раз и рендерит.
export function HeaderSidebarTrigger() {
  const { isMobile } = useSidebar()
  if (!isMobile) return null

  return (
    <>
      <SidebarTrigger className="text-muted-foreground" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
    </>
  )
}
