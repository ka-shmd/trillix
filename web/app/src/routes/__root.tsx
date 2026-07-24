import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { Toaster } from '@/components/ui/sonner'

// Корневой маршрут несёт queryClient в контексте: гарды дочерних маршрутов
// (_app, _auth) через него префетчат /auth/me в beforeLoad.
// Toaster (shadcn/sonner) монтируется здесь — над _app и _auth, — чтобы toast()
// был доступен из любого экрана кабинета (первый потребитель — удаление блока, 13.2).
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <>
      <Outlet />
      <Toaster />
    </>
  ),
})
