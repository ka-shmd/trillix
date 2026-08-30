import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

import { type FormDetail } from '../../../entities/form'
import { formKeys } from '../keys'
import { formLockToken } from './useAutosave'

// Токен оптимистичной блокировки автосейва читается из ЕДИНОГО источника — кэша
// detail в Query, который двигают все мутации формы (автосейв схемы, публикация).
// Читать его из приватного ref нельзя: разъехавшись с кэшем, автосейв ушлёт
// устаревший updatedAt и словит 409 «Форма изменена в другой вкладке» на пустом месте.
//
// Гонка «rename заголовка ↔ автосейв», которую этот набор сторожил до фазы 15, больше
// невозможна: заголовок стал блоком документа и едет тем же PATCH'ем схемы, второго
// пути записи не осталось.

const formId = 'form-1'
const T0 = '2026-07-15T10:00:00.000Z'

const draftSchema = { blocks: [] } as FormDetail['draftSchema']

function seedDetail(qc: QueryClient) {
  qc.setQueryData<FormDetail>(formKeys.detail(formId), {
    id: formId,
    name: null,
    title: 'Старое имя',
    slug: 'old-slug',
    status: 'draft',
    createdAt: T0,
    updatedAt: T0,
    publishedVersion: null,
    publishedVersionId: null,
    // Специально true: ответ мутации переименования всегда несёт false — патч не
    // должен затереть это поле мусором из мутации.
    hasUnpublishedChanges: true,
    submissionCount: 3,
    visitCount: 0,
    visitSubmittedCount: 0,
    draftSchema,
    closeAt: null,
    responseLimit: null,
    closedMessage: null,
    closedTitle: null,
    notifyOnSubmission: true,
    collectPartial: false,
    branding: true,
    progress: true,
    autoJump: false,
    saveLocally: false,
    notifyEmail: null,
    linkPreview: null,
    notifyMail: { from: '', to: '', fromName: '', subject: '' },
  })
}

describe('formLockToken', () => {
  it('без кэша detail отдаёт fallback', () => {
    const qc = new QueryClient()
    expect(formLockToken(qc, formId, T0)).toBe(T0)
  })

  it('берёт updatedAt из кэша detail, а не fallback', () => {
    const qc = new QueryClient()
    seedDetail(qc)
    expect(formLockToken(qc, formId, 'ignored')).toBe(T0)
  })
})
