import { type VersionStat } from '../../entities/versionStats'
import { type VisitsBreakdown } from '../../entities/visitsBreakdown'
import { type SegmentDim } from '../../shared/segment'

// Значения сегмента для списка выбора: те же подписи, что в разбивке «Визитов» за то
// же окно, — сервер сводит сегмент к визитам по ним же (domain.UserAgentFilter,
// SourceFilter). Своих подписей здесь нет: разъехавшись, они давали бы сегменты, в
// которые не попадает ни один визит.
export type SegmentOption = { value: string; label: string }

export function segmentOptions(
  dim: SegmentDim,
  breakdown: VisitsBreakdown | undefined,
  versions: VersionStat[] | undefined,
): SegmentOption[] {
  if (dim === 'version') {
    return (versions ?? []).map((v) => ({ value: String(v.number), label: `Версия ${v.number}` }))
  }
  if (!breakdown) return []
  switch (dim) {
    case 'device':
      return breakdown.devices.map((l) => ({ value: l.label, label: l.label }))
    case 'browser':
      return breakdown.browsers.map((l) => ({ value: l.label, label: l.label }))
    case 'os':
      return breakdown.systems.map((l) => ({ value: l.label, label: l.label }))
    case 'source': {
      // Источник без канала: «vk.com» — все каналы vk.com, как режет сервер.
      const names = [...new Set(breakdown.sources.map((s) => s.source))]
      return names.map((name) => ({ value: name, label: name }))
    }
    case 'country':
      return breakdown.countries.map((c) => ({ value: c.countryCode, label: c.name }))
    case 'city': {
      // Одноимённые города разных стран — разные места; код страны в подписи только
      // там, где без него строки не различить.
      const counts = new Map<string, number>()
      for (const c of breakdown.cities) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
      return breakdown.cities.map((c) => ({
        value: `${c.countryCode}:${c.name}`,
        label: (counts.get(c.name) ?? 0) > 1 ? `${c.name} (${c.countryCode})` : c.name,
      }))
    }
  }
}

// withSelected — значения окна плюс выбранное, если окно его не содержит.
//
// МИНА: сегмент живёт в адресе и переживает смену периода, а список строится по
// периоду. Выбрали «Город: Минск» за 30 дней, переключили на сутки — визитов из
// Минска за сутки не было, значения в списке нет. Radix на value вне списка рисует
// триггер ПУСТЫМ (не плейсхолдером), и экран перестаёт называть то, чем отфильтрован,
// продолжая фильтровать. Подпись здесь своя, из самого значения: подписи разбивки за
// это окно нет, а взять её неоткуда.
export function withSelected(
  options: SegmentOption[],
  dim: SegmentDim,
  value: string | undefined,
): SegmentOption[] {
  if (!value || options.some((o) => o.value === value)) return options
  return [...options, { value, label: selectedLabel(dim, value) }]
}

function selectedLabel(dim: SegmentDim, value: string): string {
  if (dim === 'version') return `Версия ${value}`
  if (dim === 'city') {
    const sep = value.indexOf(':')
    // Город всегда приходит парой «КОД:Имя» (domain.CityKey); без кода показывать
    // нечего, кроме самого значения.
    if (sep > 0) return `${value.slice(sep + 1)} (${value.slice(0, sep)})`
  }
  return value
}
