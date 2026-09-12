import { z } from 'zod'

import { apiRequest } from '../../shared/api/client'
import {
  deliveryPageSchema,
  formIntegrationsSchema,
  formSheetSchema,
  sheetListSchema,
  spreadsheetListSchema,
  webhookSchema,
  webhookSecretSchema,
  webhookTestSchema,
  type DeliveryPage,
  type FormIntegrations,
  type FormSheet,
  type SheetRef,
  type SpreadsheetRef,
  type Webhook,
  type WebhookHeader,
  type WebhookTest,
} from '../../entities/integration'

// Транспорт интеграций. Ответы парсятся Zod-схемой на границе — непровалидированный
// any внутрь приложения не проходит (web/CLAUDE.md).

// Зеркалит pickerResponse в internal/integrations/handler.go.
const pickerCredentialsSchema = z.object({
  accessToken: z.string(),
  developerKey: z.string(),
  appId: z.string(),
})

export type PickerCredentials = z.infer<typeof pickerCredentialsSchema>

export function getFormIntegrations(formId: string): Promise<FormIntegrations> {
  return apiRequest(`/forms/${formId}/integrations`, { schema: formIntegrationsSchema })
}

// ConnectOptions — то, что человек назвал в окне подключения.
export interface ConnectOptions {
  // accountId — каким подключением ехать. Обязателен: аккаунтов у человека
  // сколько угодно, и «подразумеваемого» среди них нет.
  accountId: string
  name: string
  // Пусто — заводим новую книгу; иначе работаем в выбранной.
  spreadsheetId: string
  // Существующий лист книги; null — завести новый. Не 0: у первого листа книги
  // gid как раз ноль.
  sheetId: number | null
  backfill: boolean
}

export function createSheet(formId: string, opts: ConnectOptions): Promise<FormSheet> {
  return apiRequest(`/forms/${formId}/integrations/google`, {
    method: 'POST',
    body: {
      accountId: opts.accountId,
      name: opts.name,
      spreadsheetId: opts.spreadsheetId,
      sheetId: opts.sheetId,
      backfill: opts.backfill,
    },
    schema: formSheetSchema,
  })
}

// Листы выбранной книги — второй шаг выбора.
//
// Адрес по АККАУНТУ, а не по форме: книга лежит в чужом Диске, и право на её
// оглавление даёт владение аккаунтом, а не роль в пространстве (ADR §10).
export async function listSheets(accountId: string, spreadsheetId: string): Promise<SheetRef[]> {
  const res = await apiRequest(
    `/integrations/google/accounts/${accountId}/sheets?spreadsheetId=${encodeURIComponent(spreadsheetId)}`,
    { schema: sheetListSchema },
  )
  return res.sheets
}

// Credentials окна выбора файла: живой токен Google на час. Запрашиваются по
// нажатию кнопки, а не при показе экрана, — токен не должен лежать в стейте
// страницы просто так.
export function getPickerCredentials(accountId: string): Promise<PickerCredentials> {
  return apiRequest(`/integrations/google/accounts/${accountId}/picker`, {
    schema: pickerCredentialsSchema,
  })
}

// Таблицы для выбора в окне. Запрашиваются при его открытии: список живёт у
// провайдера и устаревает, кэшировать его надолго нечестно.
export async function listSpreadsheets(accountId: string): Promise<SpreadsheetRef[]> {
  const res = await apiRequest(`/integrations/google/accounts/${accountId}/spreadsheets`, {
    schema: spreadsheetListSchema,
  })
  return res.spreadsheets
}

// Перезалить лист: вычистить его значения, написать свежую шапку и отправить все
// ответы заново.
//
// Лечение сразу нескольких бед — дубля после ретрая (доставка at-least-once),
// строк, удалённых автором руками, отставших колонок и раскладки, за которой мы
// перестали следовать. Возвращено в интерфейс решением владельца 2026-08-27:
// пока перезалив был единственным выходом из тупика, а входа к нему не было,
// человеку оставалось только удалить связку и завести заново.
export function refillSheet(formId: string, connectionId: string): Promise<void> {
  return apiRequest(`/forms/${formId}/integrations/${connectionId}/refill`, { method: 'POST' })
}

// Перепроверить, годен ли лист к записи, и снять поломку, если годен.
//
// Раскладка ломается ПРАВКОЙ ЛИСТА, а лист — чужая территория: поправив шапку
// обратно, человек не имеет способа сказать нам об этом. Без этой ручки ему
// оставалось бы ждать следующего ответа респондента, чтобы узнать, помогло ли.
//
// 204 — годен. 422 с человеческой причиной — не помогло: это ответ по существу,
// и экран показывает его текстом.
export function recheckSheet(formId: string, connectionId: string): Promise<void> {
  return apiRequest(`/forms/${formId}/integrations/${connectionId}/recheck`, { method: 'POST' })
}

// Журнал доставок связки: что уехало, что не уехало и почему. Страница курсором
// (новые сверху) — лента длиной в поток ответов целиком не отдаётся.
export function listDeliveries(
  formId: string,
  connectionId: string,
  cursor?: string,
): Promise<DeliveryPage> {
  const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return apiRequest(`/forms/${formId}/integrations/${connectionId}/deliveries${params}`, {
    schema: deliveryPageSchema,
  })
}

// Повторить одну доставку: сервер ставит событие заново, и оно проходит те же
// проверки, что обычное. 202 — поставлено, а не доставлено: исход появится в той
// же ленте отдельной строкой, когда диспетчер до него дойдёт.
//
// 409 — связка сломана: её события гасятся первой же проверкой доставки, и
// повтор до починки молча ничего не дал бы.
export function retryDelivery(
  formId: string,
  connectionId: string,
  deliveryId: string,
): Promise<void> {
  return apiRequest(
    `/forms/${formId}/integrations/${connectionId}/deliveries/${deliveryId}/retry`,
    { method: 'POST' },
  )
}

// Операции над ОДНОЙ связкой адресуются её id: связок у формы сколько угодно.
//
// Отключения аккаунта здесь нет: ручка на бэке есть (API.md), но она рвёт
// подключение ЦЕЛИКОМ и каскадом уносит связки всех форм и пространств, которые
// им ехали, — окну настройки одной связки такой кнопки не положено (решение
// владельца 2026-08-27). Её место — экран аккаунта, записано в BACKLOG.
export function unlinkSheet(formId: string, connectionId: string): Promise<void> {
  return apiRequest(`/forms/${formId}/integrations/${connectionId}`, { method: 'DELETE' })
}

// updateConnection шлёт ровно то, что дали: поля цели необязательны, и их
// отсутствие в теле означает «цель не трогать» (так шлёт тумблер из списка).
export function updateConnection(
  formId: string,
  connectionId: string,
  patch: {
    name: string
    enabled: boolean
    accountId?: string
    spreadsheetId?: string
    sheetId?: number | null
    backfill?: boolean
  },
): Promise<void> {
  return apiRequest(`/forms/${formId}/integrations/${connectionId}`, {
    method: 'PATCH',
    body: patch,
  })
}

// startUrl — адрес, с которого начинается поход за согласием Google. Это не
// вызов API, а НАВИГАЦИЯ: бэк отвечает редиректом и ставит cookie похода,
// поэтому адрес нужен ссылкой/окном, а не fetch'ем.
//
// Пространства в адресе нет: человек подключает СВОЙ аккаунт, а не аккаунт
// команды.
//
// reconnect — id переподключаемого аккаунта. Адрес у обоих действий один: разницу
// делает эта подсказка — сервер берёт почту названного аккаунта и передаёт её
// Google (login_hint), чтобы человек попал сразу в нужный аккаунт, а не выбирал
// из всех своих. Без неё это «подключить ещё один».
export function startUrl(reconnect?: string): string {
  const base = '/api/v1/integrations/google/start'
  return reconnect ? `${base}?accountId=${encodeURIComponent(reconnect)}` : base
}

// ВЕБХУКИ (фаза 28). Второй вид цели доставки: адрес чужой системы вместо
// таблицы. Адреса свои — под формой, как и связки.

// Подключение — это адрес и название. Секрет подписи едет тем же запросом, если
// человек нажал «Подписывать запросы» и ввёл его: подпись предлагают сразу, но по
// умолчанию её нет. Обратно секрет не возвращается — его ввёл сам автор.
export function createWebhook(
  formId: string,
  input: { name: string; url: string; secret?: string; headers?: WebhookHeader[] },
): Promise<Webhook> {
  return apiRequest(`/forms/${formId}/webhooks`, {
    method: 'POST',
    body: input,
    schema: webhookSchema,
  })
}

// Правка шлёт ровно названные поля: не названное сервер не трогает (так шлёт
// тумблер из списка). Адрес, переданный даже тем же, делает правящего
// ответственным за доставку и снимает поломку.
export function updateWebhook(
  formId: string,
  webhookId: string,
  patch: { name?: string; url?: string; enabled?: boolean; headers?: WebhookHeader[] },
): Promise<void> {
  return apiRequest(`/forms/${formId}/webhooks/${webhookId}`, { method: 'PATCH', body: patch })
}

export function deleteWebhook(formId: string, webhookId: string): Promise<void> {
  return apiRequest(`/forms/${formId}/webhooks/${webhookId}`, { method: 'DELETE' })
}

// Секрет подписи — отдельной ручкой по нажатию «Показать», а не в состоянии
// таба: раздавать ключ подписи на каждый показ экрана незачем.
export function getWebhookSecret(formId: string, webhookId: string): Promise<string> {
  return apiRequest(`/forms/${formId}/webhooks/${webhookId}/secret`, {
    schema: webhookSecretSchema,
  }).then((r) => r.secret)
}

// Включить подпись либо сменить секрет. Действует сразу: старый секрет перестаёт
// подходить без переходного окна.
//
// Секрет придумывает автор — своего продукт не генерирует. Планка длины на бэке
// (16 символов), здесь только не даём отправить заведомо короткий.
export function setWebhookSecret(formId: string, webhookId: string, secret: string): Promise<void> {
  return apiRequest(`/forms/${formId}/webhooks/${webhookId}/secret`, {
    method: 'POST',
    body: { secret },
  })
}

// Выключение подписи: секрет удаляется, заголовок в запросах пропадает.
export function disableWebhookSignature(formId: string, webhookId: string): Promise<void> {
  return apiRequest(`/forms/${formId}/webhooks/${webhookId}/secret`, { method: 'DELETE' })
}

// Проверка шлёт получателю образец с пометкой test. Удачная будит цель: и
// сломанную, и спящую после неудачи — накопленная очередь уедет следом.
export function testWebhook(formId: string, webhookId: string): Promise<WebhookTest> {
  return apiRequest(`/forms/${formId}/webhooks/${webhookId}/test`, {
    method: 'POST',
    schema: webhookTestSchema,
  })
}

export function listWebhookDeliveries(
  formId: string,
  webhookId: string,
  cursor?: string,
): Promise<DeliveryPage> {
  const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return apiRequest(`/forms/${formId}/webhooks/${webhookId}/deliveries${params}`, {
    schema: deliveryPageSchema,
  })
}

export function retryWebhookDelivery(
  formId: string,
  webhookId: string,
  deliveryId: string,
): Promise<void> {
  return apiRequest(`/forms/${formId}/webhooks/${webhookId}/deliveries/${deliveryId}/retry`, {
    method: 'POST',
  })
}
