import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { NotFound } from './shared/NotFound'
import { ErrorScreen } from './shared/ErrorScreen'
import './index.css'
// Общие стили полей формы (rf-*) — единый источник с рендерером, см.
// web/shared/fields/fields.css. После index.css: unlayered rf-* перебивают base-слой Tailwind.
import '@fields/fields.css'

const queryClient = new QueryClient()
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultNotFoundComponent: NotFound,
  defaultErrorComponent: ErrorScreen,
})

// Регистрируем тип роутера для типобезопасных Link/navigate во всём приложении.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
