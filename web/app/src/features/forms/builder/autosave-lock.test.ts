import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

import { type Form, type FormDetail } from '../../../entities/form'
import { formKeys } from '../keys'
import { renameDetailPatch } from '../queries'
import { formLockToken } from './useAutosave'

// Регрессия на гонку оптимистичной блокировки rename ↔ автосейв схемы:
// переименование заголовка двигает forms.updated_at, и следующий PATCH схемы обязан
// уйти со СВЕЖИМ токеном, иначе сервер вернёт 409 «Форма изменена в другой вкладке».
// Токен — единый источник (кэш detail): rename пишет туда новый updatedAt
// (renameDetailPatch), автосейв читает оттуда (formLockToken).

const formId = 'form-1'
const T0 = '2026-07-15T10:00:00.000Z'
const T1 = '2026-07-15T10:00:05.000Z'

const draftSchema = { blocks: [] } as FormDetail['draftSchema']

function seedDetail(qc: QueryClient) {
  qc.setQueryData<FormDetail>(formKeys.detail(formId), {
    id: formId,
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
    draftSchema,
  })
}

// Ответ PATCH /forms/{id} на переименование: свежий updatedAt, но заглушечные
// hasUnpublishedChanges/submissionCount (у ответов мутаций всегда false/0).
const renamedForm: Form = {
  id: formId,
  title: 'Новое имя',
  slug: 'old-slug',
  status: 'draft',
  createdAt: T0,
  updatedAt: T1,
  publishedVersion: null,
  publishedVersionId: null,
  hasUnpublishedChanges: false,
  submissionCount: 0,
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

describe('гонка rename ↔ автосейв', () => {
  it('переименование двигает токен блокировки, который прочтёт автосейв', () => {
    const qc = new QueryClient()
    seedDetail(qc)

    // Токен до переименования — старый.
    expect(formLockToken(qc, formId, T0)).toBe(T0)

    // Переименование патчит detail так же, как useRenameForm.onSuccess.
    qc.setQueryData<FormDetail>(formKeys.detail(formId), renameDetailPatch(renamedForm))

    // Автосейв схемы теперь прочтёт СВЕЖИЙ токен → уйдёт с T1, а не устаревшим T0,
    // и не словит 409.
    expect(formLockToken(qc, formId, T0)).toBe(T1)
  })

  it('патч rename обновляет title, но не затирает поля, отсутствующие в rename', () => {
    const qc = new QueryClient()
    seedDetail(qc)

    qc.setQueryData<FormDetail>(formKeys.detail(formId), renameDetailPatch(renamedForm))
    const detail = qc.getQueryData<FormDetail>(formKeys.detail(formId))

    expect(detail?.title).toBe('Новое имя')
    expect(detail?.updatedAt).toBe(T1)
    // draftSchema сохранён (в ответе мутации его нет).
    expect(detail?.draftSchema).toBe(draftSchema)
    // Заглушки из ответа мутации не протекли в кэш.
    expect(detail?.hasUnpublishedChanges).toBe(true)
    expect(detail?.submissionCount).toBe(3)
  })

  it('на пустом кэше detail патч rename — no-op (dashboard без открытой формы)', () => {
    const qc = new QueryClient()
    qc.setQueryData<FormDetail>(formKeys.detail(formId), renameDetailPatch(renamedForm))
    expect(qc.getQueryData<FormDetail>(formKeys.detail(formId))).toBeUndefined()
  })
})
