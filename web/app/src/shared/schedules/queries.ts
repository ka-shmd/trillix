// Транспорт и кэш расписаний живут в shared, а не в фиче: их спрашивают ДВЕ фичи —
// экран расписаний и попап блока «Запись» на полотне, — а импорт фичи из фичи запрещён
// (web/CLAUDE.md). Компоненты экрана при этом остались в features/schedules.
import { queryOptions, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'

import { scheduleKeys } from './keys'
import {
  addBlock,
  cancelBooking,
  createSchedule,
  deleteSchedule,
  getCalendar,
  getSchedule,
  listBlocks,
  listBookings,
  listSchedules,
  moveBooking,
  removeBlock,
  updateSchedule,
} from './api'
import { type Schedule, type ScheduleInput } from '../../entities/schedule'

export function schedulesQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: scheduleKeys.list(workspaceId),
    queryFn: () => listSchedules(workspaceId),
  })
}

export function scheduleQueryOptions(scheduleId: string) {
  return queryOptions({
    queryKey: scheduleKeys.detail(scheduleId),
    queryFn: () => getSchedule(scheduleId),
  })
}

// listedSchedule — расписание из уже прочитанного списка любого пространства. Строка
// списка — тот же документ плюс счётчики, поэтому страница расписания, открытая со
// списка, рисуется им сразу, а свежий документ доезжает запросом поверх.
export function listedSchedule(qc: QueryClient, scheduleId: string): Schedule | undefined {
  for (const [, items] of qc.getQueriesData<Schedule[]>({ queryKey: scheduleKeys.lists() })) {
    const found = items?.find((s) => s.id === scheduleId)
    if (found) return found
  }
  return undefined
}

export function blocksQueryOptions(scheduleId: string) {
  return queryOptions({
    queryKey: scheduleKeys.blocks(scheduleId),
    queryFn: () => listBlocks(scheduleId),
  })
}

export function bookingsQueryOptions(scheduleId: string) {
  return queryOptions({
    queryKey: scheduleKeys.bookings(scheduleId),
    queryFn: () => listBookings(scheduleId),
  })
}

// calendarQueryOptions — окно полотна. Границы приезжают готовыми строками RFC 3339
// от самого полотна: считать их здесь значило бы завести второе место, где решают,
// какая неделя показана.
export function calendarQueryOptions(scheduleId: string, from: string, to: string) {
  return queryOptions({
    queryKey: scheduleKeys.calendar(scheduleId, from, to),
    queryFn: () => getCalendar(scheduleId, from, to),
    // Показанная неделя остаётся на экране, пока грузится соседняя: иначе листание
    // мигает пустым полотном на каждый шаг.
    placeholderData: (prev) => prev,
  })
}

export function useCreateSchedule(workspaceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ScheduleInput) => createSchedule(workspaceId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: scheduleKeys.list(workspaceId) }),
  })
}

// Правка инвалидирует и карточку, и СПИСОК: имя расписания стоит в списке, и
// оставшееся старое читалось бы как «правка не сохранилась».
export function useUpdateSchedule(scheduleId: string, workspaceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ScheduleInput) => updateSchedule(scheduleId, input),
    onSuccess: (next) => {
      qc.setQueryData(scheduleKeys.detail(scheduleId), next)
      void qc.invalidateQueries({ queryKey: scheduleKeys.list(workspaceId) })
    },
  })
}

export function useDeleteSchedule(scheduleId: string, workspaceId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => deleteSchedule(scheduleId),
    onSuccess: () => {
      qc.removeQueries({ queryKey: scheduleKeys.detail(scheduleId) })
      void qc.invalidateQueries({ queryKey: scheduleKeys.list(workspaceId) })
    },
  })
}

// Блокировка меняет ЗАНЯТОЕ, то есть и свободное время формы. В кабинете от неё
// зависит один список — его и инвалидируем; публичная выдача ничего не кэширует
// (no-store), поэтому доезжает сама.
export function useAddBlock(scheduleId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (block: { startsAt: string; endsAt: string; note: string }) =>
      addBlock(scheduleId, block),
    onSuccess: () => invalidateBusy(qc, scheduleId),
  })
}

export function useRemoveBlock(scheduleId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (blockId: string) => removeBlock(scheduleId, blockId),
    onSuccess: () => invalidateBusy(qc, scheduleId),
  })
}

// Отмена записи инвалидирует список ближайших: отменённая обязана из него уйти.
export function useCancelBooking(scheduleId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (bookingId: string) => cancelBooking(scheduleId, bookingId),
    onSuccess: () => invalidateBusy(qc, scheduleId),
  })
}

// Перенос меняет ЗАНЯТОЕ так же, как отмена: место уходит с одной точки оси и
// появляется на другой.
export function useMoveBooking(scheduleId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { bookingId: string; startsAt: string }) =>
      moveBooking(scheduleId, v.bookingId, v.startsAt),
    onSuccess: () => invalidateBusy(qc, scheduleId),
  })
}

// invalidateBusy — всё, что показывает ЗАНЯТОЕ: список ближайших, список блокировок
// и полотно целиком (все его недели: какие именно затронуты, знать неоткуда).
// Разъехаться этим трём нельзя — они об одном и том же.
function invalidateBusy(qc: ReturnType<typeof useQueryClient>, scheduleId: string) {
  void qc.invalidateQueries({ queryKey: scheduleKeys.blocks(scheduleId) })
  void qc.invalidateQueries({ queryKey: scheduleKeys.bookings(scheduleId) })
  void qc.invalidateQueries({ queryKey: scheduleKeys.calendarAll(scheduleId) })
}
