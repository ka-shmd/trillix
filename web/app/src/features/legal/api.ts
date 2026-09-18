import { apiRequest } from '../../shared/api/client'
import {
  consentsSchema,
  documentsSchema,
  legalDocumentSchema,
  type ConsentChange,
  type ConsentKind,
  type Consents,
  type DocumentSummary,
  type LegalDocument,
  type SignupProfile,
} from '../../entities/legal'

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

// Документы публичны: страницы /legal открываются без входа.
export async function getDocuments(): Promise<DocumentSummary[]> {
  return (await apiRequest('/legal/documents', { schema: documentsSchema })).items
}

export function getDocument(kind: ConsentKind, version: string): Promise<LegalDocument> {
  const query = version ? `?version=${encodeURIComponent(version)}` : ''
  return apiRequest(`/legal/documents/${kind}${query}`, { schema: legalDocumentSchema })
}
