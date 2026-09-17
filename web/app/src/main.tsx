import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { NotFound } from './shared/NotFound'
import { ErrorScreen } from './shared/ErrorScreen'
import { consentRedirectFor } from './shared/api/consentGate'
import { authKeys } from './features/auth/keys'
import './index.css'
// Общие стили полей формы (rf-*) — единый источник с рендерером, см.
// web/shared/fields/fields.css. После index.css: unlayered rf-* перебивают base-слой Tailwind.
import '@fields/fields.css'

// Гейт согласия посреди сессии (docs/design/signup-consent.md §3.2): 403
// consent_required от любой ручки — вышла существенная редакция соглашения или адрес
// открыт мимо гарда _app (/join/{token}). me сносится до перехода: иначе экран согласия
// прочёл бы устаревший кэш с consentRequired=false и отослал бы обратно.
function onApiError(err: unknown) {
  const target = consentRedirectFor(err, router.state.location)
  if (!target) return
  queryClient.removeQueries({ queryKey: authKeys.me() })
  void router.navigate({ to: '/welcome', search: target })
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
})
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
