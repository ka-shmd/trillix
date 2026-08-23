import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { integrationKeys } from './keys'
import {
  createSheet,
  disconnectAccount,
  getFormIntegrations,
  listSheets,
  listSpreadsheets,
  refillSheet,
  unlinkSheet,
  updateConnection,
  type ConnectOptions,
} from './api'

// Состояние интеграций формы одной поездкой: аккаунт пространства и привязка
// формы приезжают вместе — экран показывает их как одно целое.
//
// refetchInterval во время переноса: он идёт пачками в фоне, и статус меняется
// без участия человека. Без опроса экран висел бы на «переносим» до F5, и
// человек решил бы, что сломалось.
export function formIntegrationsQueryOptions(formId: string) {
  return queryOptions({
    queryKey: integrationKeys.form(formId),
    queryFn: () => getFormIntegrations(formId),
    // Опрашиваем, пока хоть одна связка переносит накопленные ответы: перенос
    // идёт пачками в фоне, и без опроса экран висел бы на «переносим» до F5.
    refetchInterval: (query) =>
      query.state.data?.connections.some((c) => c.status === 'backfilling') ? 3000 : false,
  })
}

// Мутации инвалидируют состояние формы: забытая инвалидация — баг, а не мелочь
// (web/CLAUDE.md). Тронуть тут нужно ровно один ключ — состояние этой формы.
// Список таблиц запрашивается только когда окно открыто и аккаунт подключён:
// это поход к провайдеру, и делать его на каждый показ таба незачем.
export function spreadsheetsQueryOptions(formId: string) {
  return queryOptions({
    queryKey: [...integrationKeys.form(formId), 'spreadsheets'] as const,
    queryFn: () => listSpreadsheets(formId),
    staleTime: 30_000,
  })
}

// Листы выбранной книги. Ключ несёт id книги: выбрал другую — приехали её листы,
// а не остались чужие.
export function sheetsQueryOptions(formId: string, spreadsheetId: string) {
  return queryOptions({
    queryKey: [...integrationKeys.form(formId), 'sheets', spreadsheetId] as const,
    queryFn: () => listSheets(formId, spreadsheetId),
    staleTime: 30_000,
  })
}

export function useCreateSheet(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (opts: ConnectOptions) => createSheet(formId, opts),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
  })
}

export function useRefillSheet(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (connectionId: string) => refillSheet(formId, connectionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
  })
}

export function useUnlinkSheet(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (connectionId: string) => unlinkSheet(formId, connectionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
  })
}

export function useUpdateConnection(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { id: string; name: string; enabled: boolean }) =>
      updateConnection(formId, vars.id, { name: vars.name, enabled: vars.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
  })
}

// Отключение аккаунта — операция ПРОСТРАНСТВА: она уносит привязки всех его
// форм, поэтому инвалидируется весь раздел интеграций, а не одна форма.
export function useDisconnectAccount(workspaceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => disconnectAccount(workspaceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.all() }),
  })
}
