// ВРЕМЯ АВТОРА — ВРЕМЯ РАСПИСАНИЯ, а не устройства, с которого он смотрит
// (design/booking.md §4.9). Расписание живёт в своём поясе, а автор бывает в другом:
// в поездке, в командировке, просто с чужого ноутбука. Пояс браузера здесь брать
// нельзя ни на вводе, ни на показе — иначе «закрыть 14 сентября с 10:00 до 11:00»
// уедет в базу тремя часами раньше, автор увидит на экране правильные «10:00»
// (тем же смещением прочитано, каким записано), а клиенты запишутся в закрытый час.
//
// Своя арифметика, а не библиотека: Intl уже умеет разворачивать момент в любой пояс,
// и обратный перевод — это два вызова того же Intl (ниже). Ради двадцати строк тянуть
// в кабинет date-fns-tz незачем; понадобится третья операция с поясами — развилку
// стоит пересмотреть.

// offsetAt — смещение пояса в МОМЕНТ времени at, в миллисекундах. Именно в момент:
// летом и зимой оно разное, и постоянного смещения у пояса не существует.
function offsetAt(at: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts: Record<string, number> = {}
  for (const part of dtf.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  // Полночь часть движков отдаёт как «24»: без поправки сутки уезжают вперёд.
  const hour = parts.hour === 24 ? 0 : (parts.hour ?? 0)
  const asUTC = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    hour,
    parts.minute ?? 0,
    parts.second ?? 0,
  )
  return asUTC - at.getTime()
}

// zonedToUTC — «14 сентября, 10:00 в поясе расписания» → точка на оси времени.
// Пустая строка при неразбираемом вводе: сюда приходят значения полей формы.
export function zonedToUTC(date: string, time: string, timeZone: string): string {
  const naive = Date.parse(`${date}T${time}:00Z`)
  if (Number.isNaN(naive)) return ''
  // Два прохода: смещение зависит от момента, а момент — от смещения. Первый проход
  // ошибается только вокруг перевода часов, второй считает уже от верной даты.
  const once = naive - offsetAt(new Date(naive), timeZone)
  const twice = naive - offsetAt(new Date(once), timeZone)
  return new Date(twice).toISOString()
}
