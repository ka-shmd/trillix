import { apiRequest } from '../../shared/api/client'
import { notificationFeedSchema, type NotificationFeed } from '../../entities/notification'

// Транспорт уведомлений: ответ парсится Zod-схемой на границе.

export function listNotifications(): Promise<NotificationFeed> {
  return apiRequest('/notifications', { schema: notificationFeedSchema })
}

// markRead отмечает прочитанными названные строки либо всё разом. Чужие id
// сервер просто не найдёт — отбор идёт по сессии, а не по телу запроса.
export function markNotificationsRead(body: { ids: string[] } | { all: true }): Promise<void> {
  return apiRequest('/notifications/read', { method: 'POST', body })
}
