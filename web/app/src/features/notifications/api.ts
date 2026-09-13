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

// deleteNotification убирает одну строку насовсем. От прочтения отличается тем,
// что строки не остаётся вовсе: прочитанная живёт историей до уборщика.
export function deleteNotification(id: string): Promise<void> {
  return apiRequest(`/notifications/${id}`, { method: 'DELETE' })
}

// deleteAllNotifications чистит ленту целиком, включая непрочитанное: это решение
// человека, а не уборка по возрасту.
export function deleteAllNotifications(): Promise<void> {
  return apiRequest('/notifications', { method: 'DELETE' })
}
