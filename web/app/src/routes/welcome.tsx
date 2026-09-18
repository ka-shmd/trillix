import { useCallback } from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import { meQueryOptions } from '../features/auth/queries'
import { authKeys } from '../features/auth/keys'
import { WelcomeScreen } from '../features/legal/WelcomeScreen'
import { safeRedirect } from '../shared/api/consentGate'

// Экран согласия (docs/design/signup-consent.md §3.3). Вне _app: там гард уводит сюда
// же, а сайдбар кабинета человеку, для которого кабинет закрыт, рисовать нечем. Вне
// _auth: тот уводит вошедшего в кабинет.
//
// redirect — куда человек шёл. Мусор гасит catch, чужой адрес — safeRedirect.
const welcomeSearchSchema = z.object({
  redirect: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/welcome')({
  validateSearch: welcomeSearchSchema,
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions).catch(() => null)
    if (!me) throw redirect({ to: '/login' })
    if (!me.consentRequired) throw redirect({ href: safeRedirect(search.redirect) })
  },
  component: WelcomePage,
})

function WelcomePage() {
  const { redirect: target } = Route.useSearch()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: me } = useQuery(meQueryOptions)
  const defaultName = { firstName: me?.firstName ?? '', lastName: me?.lastName ?? '' }

  // me сносится, а не патчится: гард _app перечитает его и сам решит, открыт ли кабинет.
  const onDone = useCallback(() => {
    qc.removeQueries({ queryKey: authKeys.me() })
    void navigate({ href: safeRedirect(target) })
  }, [qc, navigate, target])

  return <WelcomeScreen defaultName={defaultName} onDone={onDone} />
}
