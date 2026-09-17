import { apiRequest } from '../../shared/api/client'
import { consentsSchema, type ConsentChange, type Consents, type SignupProfile } from '../../entities/legal'

export function getConsents(): Promise<Consents> {
  return apiRequest('/account/consents', { schema: consentsSchema })
}

export function applyConsents(body: ConsentChange): Promise<Consents> {
  return apiRequest('/account/consents', { method: 'POST', body, schema: consentsSchema })
}

// Анкета уходит ПОСЛЕ принятия соглашения: ручка стоит за гейтом согласия.
export function saveSignupProfile(body: SignupProfile): Promise<void> {
  return apiRequest('/account/signup-profile', { method: 'PUT', body })
}
