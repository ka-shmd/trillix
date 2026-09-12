import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'

import { integrationKeys } from './keys'
import {
  createSheet,
  createWebhook,
  deleteWebhook,
  getFormIntegrations,
  listDeliveries,
  listWebhookDeliveries,
  listSheets,
  listSpreadsheets,
  recheckSheet,
  refillSheet,
  reissueWebhookSecret,
  retryDelivery,
  retryWebhookDelivery,
  testWebhook,
  unlinkSheet,
  updateConnection,
  updateWebhook,
  type ConnectOptions,
} from './api'

// Состояние интеграций формы одной поездкой: подключения спрашивающего и список
// связок приезжают вместе — экран показывает их как одно целое.
export function formIntegrationsQueryOptions(formId: string) {
  return queryOptions({
    queryKey: integrationKeys.form(formId),
    queryFn: () => getFormIntegrations(formId),
    // Опрашиваем, пока хоть одна связка переносит накопленные ответы: перенос
    // идёт пачками в фоне, и без опроса экран висел бы на «переносим» до F5.
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return false
      // Опрашиваем, пока идёт работа, которую человек ждёт глазами: перенос
      // накопленных в таблицу и очередь вебхука. Обе идут в фоне пачками, и без
      // опроса экран висел бы на «переносим» и «в очереди 3» до F5.
      const busy =
        data.connections.some((c) => c.status === 'backfilling') ||
        data.webhooks.some((w) => w.queued > 0)
      return busy ? 3000 : false
    },
  })
}

// Список таблиц запрашивается только когда окно открыто и аккаунт подключён:
// это поход к провайдеру, и делать его на каждый показ таба незачем.
export function spreadsheetsQueryOptions(formId: string, accountId: string) {
  return queryOptions({
    queryKey: integrationKeys.spreadsheets(formId, accountId),
    queryFn: () => listSpreadsheets(accountId),
    staleTime: 30_000,
  })
}

// Листы выбранной книги. Ключ несёт id книги И аккаунта: сменил любое из двух —
// приехали листы новой пары, а не остались чужие.
export function sheetsQueryOptions(formId: string, accountId: string, spreadsheetId: string) {
  return queryOptions({
    queryKey: integrationKeys.sheets(formId, accountId, spreadsheetId),
    queryFn: () => listSheets(accountId, spreadsheetId),
    staleTime: 30_000,
  })
}

// Журнал доставок — курсорная лента, новые сверху (как ответы формы). Одна
// функция на оба вида цели: у связки Таблиц и у вебхука ленты одинаковые, а
// две «почти одинаковые» опции разъехались бы на первой же правке опроса.
//
// Опрашивается, пока окно открыто: доставка идёт в фоне, и исход повторённой
// попытки появляется в ленте не сразу. Опрос останавливается сам, когда вкладка
// уходит из фокуса (умолчание React Query).
export function deliveriesQueryOptions(
  formId: string,
  target: { id: string; kind: 'sheet' | 'webhook' },
) {
  const webhook = target.kind === 'webhook'
  return infiniteQueryOptions({
    queryKey: webhook
      ? integrationKeys.webhookDeliveries(formId, target.id)
      : integrationKeys.deliveries(formId, target.id),
    queryFn: ({ pageParam }) =>
      webhook
        ? listWebhookDeliveries(formId, target.id, pageParam)
        : listDeliveries(formId, target.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: 5000,
  })
}

// Повтор доставки: 202 означает «событие поставлено», а не «ответ уехал».
// Инвалидируем ключ формы целиком — под ним лежит и лента, и состояние связки,
// а исход приедет следующим опросом.
export function useRetryDelivery(formId: string, connectionId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (deliveryId: string) => retryDelivery(formId, connectionId, deliveryId),
    onSettled: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
  })
}

// useRefreshIntegrations — перезапросить состояние после того, что произошло НЕ
// через наши мутации: подключение аккаунта Google уезжает в отдельное окно, и
// вернувшись оттуда, кабинет обязан спросить состояние заново. Само оно не
// обновится: refetch по фокусу React Query слушает только visibilitychange, а
// окно провайдера поверх вкладки документ в hidden не переводит.
export function useRefreshIntegrations(formId: string) {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: integrationKeys.form(formId) })
  }
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

// Перезалив отвечает 202: работа НАЧАТА, а не сделана — она идёт пачками в
// фоне. Инвалидация нужна сразу, чтобы связка перешла в «переносим ответы» и
// экран начал опрашивать состояние (см. refetchInterval выше).
export function useRefillSheet(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (connectionId: string) => refillSheet(formId, connectionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
  })
}

// Перепроверка меняет состояние связки (или не меняет, и тогда причина в теле
// отказа) — состояние формы перезапрашивается в обоих случаях.
export function useRecheckSheet(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (connectionId: string) => recheckSheet(formId, connectionId),
    onSettled: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
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
  // accountId едет ВМЕСТЕ с целью и без неё смысла не имеет: под scope
  // drive.file таблица видна только своему аккаунту, поэтому «сменить аккаунт,
  // оставив лист» — сломанная связка, а не настройка.
  accountId?: string
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

// --- ВЕБХУКИ (фаза 28) ---

export function useCreateWebhook(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; url: string }) => createWebhook(formId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
  })
}

// WebhookPatch — правка вебхука: не названное поле сервер не трогает.
export interface WebhookPatch {
  id: string
  name?: string
  url?: string
  enabled?: boolean
}

export function useUpdateWebhook(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...patch }: WebhookPatch) => updateWebhook(formId, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
  })
}

export function useDeleteWebhook(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (webhookId: string) => deleteWebhook(formId, webhookId),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
  })
}

// Перевыпуск секрета состояние таба не меняет (секрета там нет вовсе), поэтому
// и не инвалидирует его: новый секрет живёт в окне, которое его запросило.
export function useReissueWebhookSecret(formId: string) {
  return useMutation({
    mutationFn: (webhookId: string) => reissueWebhookSecret(formId, webhookId),
  })
}

// Проверка МЕНЯЕТ состояние: удачная будит цель, и накопленная очередь начинает
// уезжать. Инвалидация обязательна в обоих исходах — экран покажет и снятую
// поломку, и убывающую очередь.
export function useTestWebhook(formId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (webhookId: string) => testWebhook(formId, webhookId),
    onSettled: () => qc.invalidateQueries({ queryKey: integrationKeys.form(formId) }),
  })
}

export function useRetryWebhookDelivery(formId: string, webhookId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (deliveryId: string) => retryWebhookDelivery(formId, webhookId, deliveryId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: integrationKeys.form(formId) })
      void qc.invalidateQueries({ queryKey: integrationKeys.webhookDeliveries(formId, webhookId) })
    },
  })
}
