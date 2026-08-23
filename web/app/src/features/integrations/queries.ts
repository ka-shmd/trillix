import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { integrationKeys } from './keys'
import {
  createSheet,
  getFormIntegrations,
  listSheets,
  listSpreadsheets,
  unlinkSheet,
  updateConnection,
  type ConnectOptions,
} from './api'

// Состояние интеграций формы одной поездкой: аккаунт пространства и список
// связок приезжают вместе — экран показывает их как одно целое.
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

// Мутации инвалидируют состояние формы: забытая инвалидация — баг, а не мелочь
// (web/CLAUDE.md). Тронуть нужно ровно один ключ — состояние этой формы.
export function useCreateSheet(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (opts: ConnectOptions) => createSheet(formId, opts),
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

// ConnectionPatch — правка связки. Цель (таблица и лист) необязательна: тумблер
// из списка шлёт правку БЕЗ неё, и тогда сервер цель не трогает вовсе.
export interface ConnectionPatch {
  id: string
  name: string
  enabled: boolean
  spreadsheetId?: string
  sheetId?: number | null
  backfill?: boolean
}

export function useUpdateConnection(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: ConnectionPatch) => updateConnection(formId, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
  })
}
