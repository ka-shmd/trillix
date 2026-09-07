import { RU_TIMEZONES } from '../../entities/schedule'
import { LOCALE } from '../../shared/format'

// Показ времени и пояса расписания — одним местом на все поверхности расписаний:
// строку списка, полосу ближайших записей на рабочем столе. Разъедься форматы, одна
// и та же встреча в двух местах экрана выглядела бы разными событиями.

// bookingTime — момент записи В ПОЯСЕ РАСПИСАНИЯ, а не браузера: распорядок задан в
// нём, и поездка автора не должна сдвигать ему показ собственного расписания.
//
// Без года: список показывает ближайшее, а год в нём читается как «это было давно».
export function bookingTime(iso: string, timeZone: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleString(LOCALE, {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// zoneShort — город пояса без хвоста «(UTC+3)»: в строке списка смещение только
// занимает место, а отличает расписания друг от друга именно город.
//
// Незнакомая зона показывается своим идентификатором — тем же способом, каким её
// показывает поле выбора (timezoneOptions): подменить её ближайшим городом значило
// бы назвать чужое время своим.
export function zoneShort(timezone: string): string {
  const known = RU_TIMEZONES.find((z) => z.value === timezone)
  return known ? known.title.replace(/\s*\(.*\)$/, '') : timezone
}

// Склонение слова «запись» по числу: 1 запись, 2 записи, 5 записей. Нужно узкому
// экрану — там колонок нет, и число уходит в строку словами.
export function pluralBookings(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'запись'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'записи'
  return 'записей'
}
