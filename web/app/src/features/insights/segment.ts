import { type VersionStat } from '../../entities/versionStats'
import { type VisitsBreakdown } from '../../entities/visitsBreakdown'
import { type SegmentDim } from '../../shared/segment'

// Значения сегмента для списка выбора: те же подписи, что в разбивке «Визитов» за то
// же окно, — сервер сводит сегмент к визитам по ним же (domain.UserAgentFilter,
// SourceFilter). Своих подписей здесь нет: разъехавшись, они давали бы сегменты, в
// которые не попадает ни один визит.
//
// count — визиты значения за то же окно. Стоит в списке выбора рядом с подписью:
// разрез выбирают по величине («Телефон 2751»), и без числа приходилось закрывать
// список, смотреть разбивку и открывать снова.
export type SegmentOption = { value: string; label: string; count?: number }

export function segmentOptions(
  dim: SegmentDim,
  breakdown: VisitsBreakdown | undefined,
  versions: VersionStat[] | undefined,
): SegmentOption[] {
  if (dim === 'version') {
    return (versions ?? []).map((v) => ({
      value: String(v.number),
      label: `Версия ${v.number}`,
      count: v.visits,
    }))
  }
  if (!breakdown) return []
  switch (dim) {
    case 'device':
      return breakdown.devices.map((l) => ({ value: l.label, label: l.label, count: l.visits }))
    case 'browser':
      return breakdown.browsers.map((l) => ({ value: l.label, label: l.label, count: l.visits }))
    case 'os':
      return breakdown.systems.map((l) => ({ value: l.label, label: l.label, count: l.visits }))
    case 'source': {
      // Источник без канала: «vk.com» — все каналы vk.com, как режет сервер. Визиты
      // каналов при этом складываются: сегмент возьмёт их все.
      const byName = new Map<string, number>()
      for (const s of breakdown.sources) byName.set(s.source, (byName.get(s.source) ?? 0) + s.visits)
      return [...byName].map(([name, count]) => ({ value: name, label: name, count }))
    }
    case 'country':
      return breakdown.countries.map((c) => ({
        value: c.countryCode,
        label: c.name,
        count: c.visits,
      }))
    case 'city': {
      // Одноимённые города разных стран — разные места; код страны в подписи только
      // там, где без него строки не различить.
      const counts = new Map<string, number>()
      for (const c of breakdown.cities) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
      return breakdown.cities.map((c) => ({
        value: `${c.countryCode}:${c.name}`,
        label: (counts.get(c.name) ?? 0) > 1 ? `${c.name} (${c.countryCode})` : c.name,
        count: c.visits,
      }))
    }
  }
}

// Подпись значения сегмента из самого значения. Нужна там, где разбивки за это окно
// нет: чипс применённого разреза рисуется до любых запросов, а город приезжает в
// адресе парой «КОД:Имя» (domain.CityKey) — печатать её как есть значит показывать
// владельцу внутренний ключ.
export function segmentValueLabel(dim: SegmentDim, value: string): string {
  if (dim === 'version') return `Версия ${value}`
  if (dim === 'city') {
    const sep = value.indexOf(':')
    // Город всегда приходит парой «КОД:Имя» (domain.CityKey); без кода показывать
    // нечего, кроме самого значения.
    if (sep > 0) return `${value.slice(sep + 1)} (${value.slice(0, sep)})`
  }
  return value
}
