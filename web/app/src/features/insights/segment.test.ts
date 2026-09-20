import { describe, expect, it } from 'vitest'

import { type VisitsBreakdown } from '../../entities/visitsBreakdown'
import { segmentOptions, segmentValueLabel } from './segment'

const breakdown: VisitsBreakdown = {
  step: 'day',
  timeseries: [],
  sources: [
    { source: 'vk.com', medium: 'Нет', visits: 3, submitted: 1 },
    { source: 'vk.com', medium: 'social', visits: 2, submitted: 0 },
    { source: 'Прямые заходы', medium: 'Нет', visits: 5, submitted: 2 },
  ],
  sourcesLocked: false,
  knownSources: 5,
  devices: [{ label: 'Телефон', visits: 4, submitted: 1 }],
  browsers: [],
  systems: [],
  countries: [{ name: 'Россия', countryCode: 'RU', visits: 4, submitted: 1 }],
  cities: [
    { name: 'Москва', countryCode: 'RU', visits: 3, submitted: 1 },
    { name: 'Минск', countryCode: 'BY', visits: 1, submitted: 0 },
    { name: 'Минск', countryCode: 'RU', visits: 1, submitted: 0 },
  ],
  unknownPlace: 0,
  geoConfigured: true,
}

describe('segmentOptions', () => {
  // Визиты каналов складываются: сегмент «vk.com» возьмёт и social, и прямой, и
  // число в списке выбора обязано обещать столько же, сколько он покажет.
  it('источник — без канала, по одному на имя, визиты каналов сложены', () => {
    expect(segmentOptions('source', breakdown, undefined)).toEqual([
      { value: 'vk.com', label: 'vk.com', count: 5 },
      { value: 'Прямые заходы', label: 'Прямые заходы', count: 5 },
    ])
  })

  // Сервер разбирает «город» как «код:имя»: одноимённые города разных стран — разные.
  it('город — с кодом страны в значении и в подписи только у тёзок', () => {
    expect(segmentOptions('city', breakdown, undefined)).toEqual([
      { value: 'RU:Москва', label: 'Москва', count: 3 },
      { value: 'BY:Минск', label: 'Минск (BY)', count: 1 },
      { value: 'RU:Минск', label: 'Минск (RU)', count: 1 },
    ])
  })

  it('страна — код в значении, имя в подписи; версия — номер', () => {
    expect(segmentOptions('country', breakdown, undefined)).toEqual([
      { value: 'RU', label: 'Россия', count: 4 },
    ])
    const versions = [
      { number: 3, publishedAt: '', visits: 1, submitted: 0, timedCompletions: 0, completionDurationSec: 0 },
    ]
    expect(segmentOptions('version', undefined, versions)).toEqual([
      { value: '3', label: 'Версия 3', count: 1 },
    ])
  })

  it('пока разбивка не приехала — вариантов нет', () => {
    expect(segmentOptions('device', undefined, undefined)).toEqual([])
  })
})

// Подпись применённого разреза считается из самого значения: чипс рисуется до
// любых запросов, и разбивки за это окно под рукой может не быть вовсе.
describe('segmentValueLabel', () => {
  it('город — имя без внутреннего ключа, с кодом страны', () => {
    expect(segmentValueLabel('city', 'BY:Минск')).toBe('Минск (BY)')
  })

  it('версия — словом, остальное — как есть', () => {
    expect(segmentValueLabel('version', '2')).toBe('Версия 2')
    expect(segmentValueLabel('device', 'Планшет')).toBe('Планшет')
    expect(segmentValueLabel('country', 'BY')).toBe('BY')
  })
})
