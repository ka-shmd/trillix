// Транспорт и кэш расписаний живут в shared, а не в фиче: их спрашивают ДВЕ фичи —
// экран расписаний и попап блока «Запись» на полотне, — а импорт фичи из фичи запрещён
// (web/CLAUDE.md). Компоненты экрана при этом остались в features/schedules.
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { scheduleKeys } from './keys'
import {
  addBlock,
  cancelBooking,
  createSchedule,
  deleteSchedule,
  getSchedule,
  listBlocks,
  listBookings,
  listSchedules,
  removeBlock,
  updateSchedule,
} from './api'
import { type ScheduleInput } from '../../entities/schedule'

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
    onSuccess: () => qc.invalidateQueries({ queryKey: scheduleKeys.blocks(scheduleId) }),
  })
}

export function useRemoveBlock(scheduleId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (blockId: string) => removeBlock(scheduleId, blockId),
    onSuccess: () => qc.invalidateQueries({ queryKey: scheduleKeys.blocks(scheduleId) }),
  })
}

// Отмена записи инвалидирует список ближайших: отменённая обязана из него уйти.
export function useCancelBooking(scheduleId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (bookingId: string) => cancelBooking(scheduleId, bookingId),
    onSuccess: () => qc.invalidateQueries({ queryKey: scheduleKeys.bookings(scheduleId) }),
  })
}
