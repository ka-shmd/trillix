import { z } from 'zod'

// Уведомление кабинета. Текст и ссылку собрал СЕРВЕР (реестр поводов
// `internal/notify`), экран их не строит: у повода не может быть двух редакций —
// одна на ленту, другая на будущее сообщение в мессенджер.
export const notificationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  workspaceSlug: z.string(),
  // kind нужен экрану только как признак вида (иконка), а не как текст.
  kind: z.string(),
  text: z.string(),
  link: z.string(),
  // count — сколько событий склеилось в строку: «3 новых ответа» уже в тексте,
  // здесь то же число для значка.
  count: z.number(),
  firstAt: z.string(),
  lastAt: z.string(),
  read: z.boolean(),
})

export type Notification = z.infer<typeof notificationSchema>

export const notificationFeedSchema = z.object({
  items: z.array(notificationSchema),
  unread: z.number(),
  // nextCursor приходит, только когда есть следующая страница.
  nextCursor: z.string().optional(),
})

export type NotificationFeed = z.infer<typeof notificationFeedSchema>
