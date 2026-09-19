import { describe, expect, it } from 'vitest'

import { type VisitsBreakdown } from '../../entities/visitsBreakdown'
import { segmentOptions } from './segment'

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
  it('источник — без канала, по одному на имя', () => {
    expect(segmentOptions('source', breakdown, undefined).map((o) => o.value)).toEqual([
      'vk.com',
      'Прямые заходы',
    ])
  })

  // Сервер разбирает «город» как «код:имя»: одноимённые города разных стран — разные.
  it('город — с кодом страны в значении и в подписи только у тёзок', () => {
    expect(segmentOptions('city', breakdown, undefined)).toEqual([
      { value: 'RU:Москва', label: 'Москва' },
      { value: 'BY:Минск', label: 'Минск (BY)' },
      { value: 'RU:Минск', label: 'Минск (RU)' },
    ])
  })

  it('страна — код в значении, имя в подписи; версия — номер', () => {
    expect(segmentOptions('country', breakdown, undefined)).toEqual([{ value: 'RU', label: 'Россия' }])
    const versions = [
      { number: 3, publishedAt: '', visits: 1, submitted: 0, timedCompletions: 0, completionDurationSec: 0 },
    ]
    expect(segmentOptions('version', undefined, versions)).toEqual([{ value: '3', label: 'Версия 3' }])
  })

  it('пока разбивка не приехала — вариантов нет', () => {
    expect(segmentOptions('device', undefined, undefined)).toEqual([])
  })
})
