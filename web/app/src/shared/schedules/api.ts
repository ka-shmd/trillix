import { apiRequest } from '../api/client'
import {
  blocksResponseSchema,
  scheduleCalendarSchema,
  bookingsResponseSchema,
  scheduleBlockSchema,
  scheduleSchema,
  schedulesResponseSchema,
  type Booking,
  type Schedule,
  type ScheduleCalendar,
  type ScheduleBlock,
  type ScheduleInput,
} from '../../entities/schedule'

// Транспорт расписаний: каждый ответ парсится Zod-схемой на границе.

export async function listSchedules(workspaceId: string): Promise<Schedule[]> {
  const res = await apiRequest(`/workspaces/${workspaceId}/schedules`, {
    schema: schedulesResponseSchema,
  })
  return res.items
}

// createSchedule: 402 (лимит тарифа) прилетает ошибкой апи и разбирается вызовом.
export function createSchedule(workspaceId: string, input: ScheduleInput): Promise<Schedule> {
  return apiRequest(`/workspaces/${workspaceId}/schedules`, {
    method: 'POST',
    body: input,
    schema: scheduleSchema,
  })
}

export function getSchedule(scheduleId: string): Promise<Schedule> {
  return apiRequest(`/schedules/${scheduleId}`, { schema: scheduleSchema })
}

export function updateSchedule(scheduleId: string, input: ScheduleInput): Promise<Schedule> {
  return apiRequest(`/schedules/${scheduleId}`, {
    method: 'PATCH',
    body: input,
    schema: scheduleSchema,
  })
}

// deleteSchedule: 409 (живые будущие записи либо форма со ссылкой) прилетает
// ошибкой апи с человеческим текстом — его и показывает экран.
export function deleteSchedule(scheduleId: string): Promise<void> {
  return apiRequest(`/schedules/${scheduleId}`, { method: 'DELETE' })
}

export async function listBlocks(scheduleId: string): Promise<ScheduleBlock[]> {
  const res = await apiRequest(`/schedules/${scheduleId}/blocks`, { schema: blocksResponseSchema })
  return res.items
}

export function addBlock(
  scheduleId: string,
  block: { startsAt: string; endsAt: string; note: string },
): Promise<ScheduleBlock> {
  return apiRequest(`/schedules/${scheduleId}/blocks`, {
    method: 'POST',
    body: block,
    schema: scheduleBlockSchema,
  })
}

export function removeBlock(scheduleId: string, blockId: string): Promise<void> {
  return apiRequest(`/schedules/${scheduleId}/blocks/${blockId}`, { method: 'DELETE' })
}

export async function listBookings(scheduleId: string): Promise<Booking[]> {
  const res = await apiRequest(`/schedules/${scheduleId}/bookings`, {
    schema: bookingsResponseSchema,
  })
  return res.items
}

export function cancelBooking(scheduleId: string, bookingId: string): Promise<void> {
  return apiRequest(`/schedules/${scheduleId}/bookings/${bookingId}/cancel`, { method: 'POST' })
}

// getCalendar — два слоя полотна одним запросом. Границы обязательны обе, и сервер
// откажет 422, если окно шире потолка: полотно листается неделями.
export function getCalendar(
  scheduleId: string,
  from: string,
  to: string,
): Promise<ScheduleCalendar> {
  const q = new URLSearchParams({ from, to })
  return apiRequest(`/schedules/${scheduleId}/calendar?${q.toString()}`, {
    schema: scheduleCalendarSchema,
  })
}
