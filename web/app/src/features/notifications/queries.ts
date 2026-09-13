import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { notificationKeys } from './keys'
import {
  deleteAllNotifications,
  deleteNotification,
  listNotifications,
  markNotificationsRead,
} from './api'

// Лента уведомлений — серверный стейт, живёт только в Query.
//
// Поллинг, а не push: ни SSE, ни вебсокетов в проекте нет, и заводить их ради
// колокольчика не нужно. Минута — компромисс между «узнал почти сразу» и запросом
// на каждую открытую вкладку; ответ маленький, а лишние обновления в фоновой
// вкладке гасит `refetchIntervalInBackground` по умолчанию (false).
export const notificationsQueryOptions = queryOptions({
  queryKey: notificationKeys.feed(),
  queryFn: listNotifications,
  refetchInterval: 60_000,
  staleTime: 30_000,
})

// Отметка прочтения инвалидирует ленту: она же питает счётчик на колокольчике, и
// забытая инвалидация оставила бы точку над прочитанным.
export function useMarkNotificationsRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: markNotificationsRead,
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.feed() }),
  })
}

// Удаление инвалидирует ленту по той же причине, что и отметка: счётчик на пункте
// панели считает её строки.
export function useDeleteNotification() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteNotification(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.feed() }),
  })
}

export function useDeleteAllNotifications() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deleteAllNotifications,
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.feed() }),
  })
}
