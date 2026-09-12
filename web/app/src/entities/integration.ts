import { z } from 'zod'

// Интеграции формы (фаза 25). Зеркалит Go-DTO internal/integrations/handler.go —
// правка одной стороны требует правки другой.

// Один подключённый аккаунт Google. Аккаунт принадлежит ЧЕЛОВЕКУ, а не
// пространству (ADR §10, 2026-08-27), и их у него сколько угодно.
export const connectedAccountSchema = z.object({
  id: z.string(),
  email: z.string(),
  // needsReconnect — подключение есть, но пользоваться им нельзя: refresh-токен
  // на бэке не расшифровывается (сменился ключ контура). Лечение другое, чем у
  // «аккаунта нет», — «подключите ЗАНОВО», и до этого не работает ни одна
  // связка этого аккаунта.
  needsReconnect: z.boolean().default(false),
  connectedAt: z.string(),
})

// Подключения СПРАШИВАЮЩЕГО — то, из чего он выбирает в окне связки. Не
// «аккаунт пространства»: в команде каждый видит здесь свои.
export const integrationAccountSchema = z.object({
  // enabled — настроен ли провайдер НА КОНТУРЕ (ключи в окружении бэка).
  // Отдельно от пустого списка: «интеграции здесь нет вовсе» и «есть, но ничего
  // не подключено» — разные экраны, и путать их значит советовать человеку
  // нажать кнопку, которой у него не появится.
  enabled: z.boolean(),
  // pickerEnabled — настроено ли окно выбора файла на Диске (нужен отдельный
  // ключ). Отдельно от enabled: интеграция работает и без него — просто без
  // «выбрать существующую чужую таблицу».
  pickerEnabled: z.boolean().default(false),
  // Пустой список — состояние экрана, а не ошибка.
  accounts: z.array(connectedAccountSchema).default([]),
})

// Статус привязки формы к таблице.
export const sheetStatusSchema = z.enum(['backfilling', 'live', 'broken'])

export const formSheetSchema = z.object({
  // id связки: операции над ней адресуются им, а не формой — связок у формы
  // сколько угодно, в том числе в одну и ту же книгу.
  id: z.string(),
  url: z.string(),
  // accountId и accountEmail — каким подключением едет связка. Почта нужна и
  // когда аккаунт ЧУЖОЙ: в команде связку заводит один участник, а смотрит
  // другой, и без подписи «через кого» он увидит интеграцию, которой нет в его
  // селекте.
  accountId: z.string(),
  accountEmail: z.string(),
  // spreadsheetId и sheetId — текущая цель. Экран правки открывается тем же
  // окном, что и подключение, и обязан показать в полях то, что уже выбрано.
  spreadsheetId: z.string(),
  sheetId: z.number().int(),
  // enabled — тумблер. Выключенная связка сохраняет таблицу, колонки и историю:
  // «выключить на время» и «удалить навсегда» — разные намерения.
  enabled: z.boolean(),
  // name — подпись связки, которую человек дал в окне подключения. Пусто —
  // экран показывает имя провайдера.
  name: z.string().optional(),
  status: sheetStatusSchema,
  lastError: z.string().optional(),
  lastDeliveredAt: z.string().optional(),
})

// Вебхук формы (фаза 28). Второй вид цели доставки рядом со связкой Таблиц:
// у него тот же тумблер, тот же журнал и та же логика статуса, но своя природа —
// адрес чужой системы вместо таблицы в чужом Диске.
export const webhookStatusSchema = z.enum(['live', 'broken'])

export const webhookSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  // host — хост адреса. Приходит ВСЕГДА и виден всем, кто видит форму.
  host: z.string(),
  // url — полный адрес. Приходит только тому, кто вправе править форму: в пути
  // у Zapier и Make лежит токен получателя. Пусто — у спрашивающего нет права
  // на правку, и окно настройки ему показывать нечего.
  url: z.string().optional(),
  // signed — включена ли подпись запросов. По умолчанию выключена: подписывать
  // нужно лишь тому, кто собирается проверять подпись у себя. Сам секрет в
  // состоянии таба не приезжает никогда — за ним отдельная ручка.
  signed: z.boolean().default(false),
  enabled: z.boolean(),
  status: webhookStatusSchema,
  lastError: z.string().optional(),
  lastDeliveredAt: z.string().optional(),
  // queued — сколько ответов ждут доставки. Растёт, пока получатель молчит.
  queued: z.number().int().default(0),
})

// Секрет подписи — отдельной ручкой по нажатию «Показать». Ни в состоянии таба,
// ни в ответе на подключение его нет: секрет придумывает автор, и возвращать
// ему введённое незачем.
export const webhookSecretSchema = z.object({ secret: z.string() })

// Исход проверки адреса. Неуспех — тоже ответ (200 с ok: false): «получатель
// ответил 500» это сведения о получателе, а не ошибка кабинета.
export const webhookTestSchema = z.object({
  ok: z.boolean(),
  statusCode: z.number().int().optional(),
  reason: z.string().optional(),
  ms: z.number().default(0),
})

export const formIntegrationsSchema = z.object({
  workspaceId: z.string(),
  account: integrationAccountSchema,
  // Пустой список — состояние экрана, а не ошибка: у формы просто нет связок.
  connections: z.array(formSheetSchema),
  webhooks: z.array(webhookSchema).default([]),
})

// Одна попытка доставки в журнале связки (INTEGRATIONS.md §12). Зеркалит
// deliveryResponse в internal/integrations/handler.go.
export const deliveryOutcomeSchema = z.enum(['delivered', 'failed', 'skipped'])

export const deliverySchema = z.object({
  id: z.string(),
  // kind — что везли: один ответ или пачку переноса накопленных.
  kind: z.enum(['submission', 'backfill']),
  // submissionId — какой ответ. У пачки переноса его нет: она про диапазон.
  submissionId: z.string().optional(),
  outcome: deliveryOutcomeSchema,
  // detail — готовый русский текст причины с сервера. Пусто у успеха.
  detail: z.string().optional(),
  // rows — сколько строк легло в лист: 1 у ответа, до 200 у пачки переноса.
  rows: z.number().int().default(0),
  // httpStatus — код ответа получателя вебхука. Пусто у Таблиц и когда ответа
  // не было вовсе: таймаут, DNS, запрет адреса.
  httpStatus: z.number().int().optional(),
  createdAt: z.string(),
})

// Страница ленты. Пустой nextCursor — страница последняя.
export const deliveryPageSchema = z.object({
  deliveries: z.array(deliverySchema).default([]),
  nextCursor: z.string().optional(),
})

// Таблица, куда можно положить ответы: под scope drive.file это ТОЛЬКО файлы,
// созданные нами, — чужих документов Диска в списке нет и быть не может.
export const spreadsheetRefSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const spreadsheetListSchema = z.object({
  spreadsheets: z.array(spreadsheetRefSchema),
})

// Лист книги: gid и имя. gid — личность листа (имя автор волен переименовать),
// и у первого листа он равен нулю — поэтому «не выбрано» здесь не ноль, а
// отсутствие значения.
export const sheetRefSchema = z.object({
  id: z.number().int(),
  title: z.string(),
})

export const sheetListSchema = z.object({
  sheets: z.array(sheetRefSchema),
})

export type Webhook = z.infer<typeof webhookSchema>
export type WebhookStatus = z.infer<typeof webhookStatusSchema>
export type WebhookTest = z.infer<typeof webhookTestSchema>
export type SpreadsheetRef = z.infer<typeof spreadsheetRefSchema>
export type SheetRef = z.infer<typeof sheetRefSchema>
export type ConnectedAccount = z.infer<typeof connectedAccountSchema>
export type IntegrationAccount = z.infer<typeof integrationAccountSchema>
export type FormSheet = z.infer<typeof formSheetSchema>
export type SheetStatus = z.infer<typeof sheetStatusSchema>
export type FormIntegrations = z.infer<typeof formIntegrationsSchema>
export type Delivery = z.infer<typeof deliverySchema>
export type DeliveryOutcome = z.infer<typeof deliveryOutcomeSchema>
export type DeliveryPage = z.infer<typeof deliveryPageSchema>
