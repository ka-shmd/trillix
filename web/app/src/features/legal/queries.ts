import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { applyConsents, getConsents, getDocument, getDocuments, saveSignupProfile } from './api'
import { legalKeys } from './keys'
import type { ConsentChange, ConsentKind, SignupProfile } from '../../entities/legal'

export const consentsQueryOptions = queryOptions({
  queryKey: legalKeys.consents(),
  queryFn: getConsents,
  retry: false,
})

// Редакции меняются выкаткой, а не на глазах у человека: кэш держится долго.
export const documentsQueryOptions = queryOptions({
  queryKey: legalKeys.documents(),
  queryFn: getDocuments,
  staleTime: 30 * 60 * 1000,
})

export function documentQueryOptions(kind: ConsentKind, version: string) {
  return queryOptions({
    queryKey: legalKeys.document(kind, version),
    queryFn: () => getDocument(kind, version),
    retry: false,
    staleTime: 30 * 60 * 1000,
  })
}

// completeConsent — принятие согласий и анкета регистрации (на экране новой редакции анкеты
// нет — null). Одной мутацией: экран ждёт обоих шагов, а анкета без принятого соглашения
// получила бы 403. Ответ POST — состояние целиком, им патчится кэш согласий.
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

// Тумблер рассылок: включение принимает действующую редакцию согласия, выключение отзывает
// действующее. Ответ — состояние целиком вместе с историей.
export function useApplyConsents() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: applyConsents,
    onSuccess: (consents) => qc.setQueryData(legalKeys.consents(), consents),
  })
}
