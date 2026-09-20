import { describe, expect, it } from 'vitest'

import { visitsBreakdownSchema } from './visitsBreakdown'

// Фикстура снята с РЕАЛЬНОГО ответа: JSON сериализован тем самым Go-DTO
// (breakdownResponse из internal/visits/handler.go), а не написан по памяти.
// Выдуманная фикстура проверяла бы схему саму против себя и разошлась бы с
// сервером молча — экран получил бы undefined там, где ждал число. Пересериализована
// тем же DTO после появления submitted у строк разбивок (фаза 30).
const realResponse = {
  step: 'day',
  timeseries: [
    { at: '2026-08-24T00:00:00Z', visits: 5, submitted: 2 },
    { at: '2026-08-25T00:00:00Z', visits: 0, submitted: 0 },
  ],
  sources: [
    { source: 'newsletter', medium: 'email', visits: 3, submitted: 2 },
    { source: 'vk.com', medium: 'Нет', visits: 2, submitted: 0 },
  ],
  sourcesLocked: false,
  knownSources: 5,
  devices: [
    { label: 'Компьютер', visits: 4, submitted: 2 },
    { label: 'Телефон', visits: 1, submitted: 0 },
  ],
  browsers: [{ label: 'Chrome', visits: 5, submitted: 2 }],
  systems: [
    { label: 'Windows', visits: 4, submitted: 2 },
    { label: 'Не определено', visits: 1, submitted: 0 },
  ],
  countries: [
    { name: 'Россия', countryCode: 'RU', visits: 4, submitted: 2 },
    { name: 'США', countryCode: 'US', visits: 1, submitted: 0 },
  ],
  cities: [{ name: 'Москва', countryCode: 'RU', visits: 4, submitted: 2 }],
  unknownPlace: 2,
  geoConfigured: true,
}

describe('контракт вкладки «Визиты»', () => {
  it('разбирает реальный ответ сервера', () => {
    const parsed = visitsBreakdownSchema.parse(realResponse)
    expect(parsed.step).toBe('day')
    expect(parsed.timeseries).toHaveLength(2)
    // Нулевая корзина — не дыра в ряду: сервер достраивает пустые, и схема обязана
    // их принимать, иначе график молча схлопнется до непустых точек.
    expect(parsed.timeseries[1]?.visits).toBe(0)
    expect(parsed.sources[0]?.source).toBe('newsletter')
    expect(parsed.countries[0]?.name).toBe('Россия')
  })

  it('принимает контур без справочника гео', () => {
    // Пустые списки означают «гео на контуре нет» — экран прячет блок целиком.
    // Схема обязана это принимать: контур без справочника законен.
    const noGeo = visitsBreakdownSchema.parse({
      ...realResponse,
      countries: [],
      cities: [],
      unknownPlace: 5,
      geoConfigured: false,
    })
    expect(noGeo.countries).toEqual([])
    expect(noGeo.geoConfigured).toBe(false)
  })

  it('принимает закрытую тарифом секцию источников', () => {
    // Под замком приезжает пустой список и настоящее число визитов с источником:
    // плашка обязана показывать число владельца, а не рекламировать пустоту.
    const locked = visitsBreakdownSchema.parse({
      ...realResponse,
      sources: [],
      sourcesLocked: true,
    })
    expect(locked.sources).toEqual([])
    expect(locked.knownSources).toBe(5)
  })

  it('принимает укрупнённые шаги и не пропускает неизвестный', () => {
    // Недели и месяцы приезжают с фазы 30: слишком длинный ряд сервер складывает
    // (domain.CoarsenBuckets). Каждый шаг обязан приехать вместе с подписями оси —
    // молча отрисовать неизвестный как сутки было бы враньём на графике, поэтому
    // схема остаётся закрытым перечнем.
    expect(visitsBreakdownSchema.parse({ ...realResponse, step: 'week' }).step).toBe('week')
    expect(visitsBreakdownSchema.parse({ ...realResponse, step: 'month' }).step).toBe('month')
    expect(() => visitsBreakdownSchema.parse({ ...realResponse, step: 'quarter' })).toThrow()
  })
})
