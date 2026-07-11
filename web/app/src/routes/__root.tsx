import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'

// Корневой маршрут несёт queryClient в контексте: гарды дочерних маршрутов
// (_app, _auth) через него префетчат /auth/me в beforeLoad.
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => <Outlet />,
})
