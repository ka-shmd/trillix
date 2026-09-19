// Сегмент визитов (спека design/analytics-v2.md §5.4): одно значение одного
// измерения — «только телефоны», «только из vk.com», «только версия 3».
//
// Живёт в shared, а не в фиче: сегмент читают запросы воронки и запросы карточек, а
// это разные фичи. В адресе и в запросе — строка «измерение:значение»; разбирает и
// проверяет её сервер (domain.ParseSegment), набор измерений зеркалит segmentDims там.

export const segmentDimLabels = {
  device: 'Устройство',
  browser: 'Браузер',
  os: 'Система',
  source: 'Источник',
  country: 'Страна',
  city: 'Город',
  version: 'Версия формы',
} as const

export type SegmentDim = keyof typeof segmentDimLabels

export function isSegmentDim(s: string): s is SegmentDim {
  return Object.hasOwn(segmentDimLabels, s)
}

// Сегмент из адреса: не строка или пустая строка — сегмента нет. Смысл значения
// проверяет сервер; кривое значение даст 422 и экран ошибки с кнопкой сброса.
export function segmentFromSearch(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

export function splitSegment(segment: string | undefined): { dim: SegmentDim; value: string } | null {
  if (!segment) return null
  const i = segment.indexOf(':')
  const dim = segment.slice(0, i)
  if (i < 0 || !isSegmentDim(dim)) return null
  return { dim, value: segment.slice(i + 1) }
}

// Параметры запроса: без сегмента — ничего, чтобы ключ «все визиты» был один.
export function segmentParams(segment: string | undefined): Record<string, string> {
  return segment ? { segment } : {}
}
