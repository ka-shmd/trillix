import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { applyConsents, getConsents, saveSignupProfile } from './api'
import { legalKeys } from './keys'
import type { ConsentChange, SignupProfile } from '../../entities/legal'

export const consentsQueryOptions = queryOptions({
  queryKey: legalKeys.consents(),
  queryFn: getConsents,
  retry: false,
})

// completeConsent — принятие согласий и, если человек ответил, анкета. Одной мутацией:
// экран ждёт обоих шагов, а анкета без принятого соглашения получила бы 403. Ответ
// POST — состояние целиком, им патчится кэш согласий.
export function useCompleteConsent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ change, profile }: { change: ConsentChange; profile: SignupProfile | null }) => {
      const consents = await applyConsents(change)
      if (profile) await saveSignupProfile(profile)
      return consents
    },
    onSuccess: (consents) => qc.setQueryData(legalKeys.consents(), consents),
  })
}
