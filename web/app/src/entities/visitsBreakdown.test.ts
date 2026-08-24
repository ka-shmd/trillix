import { describe, expect, it } from 'vitest'

import { visitsBreakdownSchema } from './visitsBreakdown'

// Фикстура снята с РЕАЛЬНОГО ответа: JSON сериализован тем самым Go-DTO
// (breakdownResponse из internal/visits/handler.go), а не написан по памяти.
// Выдуманная фикстура проверяла бы схему саму против себя и разошлась бы с
// сервером молча — экран получил бы undefined там, где ждал число.
const realResponse = {
  step: 'day',
  timeseries: [
    { at: '2026-08-24T00:00:00Z', visits: 5, submitted: 2 },
    { at: '2026-08-25T00:00:00Z', visits: 0, submitted: 0 },
  ],
  sources: [
    { source: 'newsletter', medium: 'email', visits: 3 },
    { source: 'vk.com', medium: 'Нет', visits: 2 },
  ],
  sourcesLocked: false,
  knownSources: 5,
  devices: [
    { label: 'Компьютер', visits: 4 },
    { label: 'Телефон', visits: 1 },
  ],
  browsers: [{ label: 'Chrome', visits: 5 }],
  systems: [
    { label: 'Windows', visits: 4 },
    { label: 'Не определено', visits: 1 },
  ],
  countries: [
    { name: 'Россия', countryCode: 'RU', visits: 4 },
    { name: 'США', countryCode: 'US', visits: 1 },
  ],
  cities: [{ name: 'Москва', countryCode: 'RU', visits: 4 }],
  unknownPlace: 2,
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
    })
    expect(noGeo.countries).toEqual([])
    expect(noGeo.unknownPlace).toBe(5)
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

  it('не пропускает ответ с неизвестным шагом', () => {
    // Шаг выбирает сервер, и новый шаг (неделя, месяц) обязан приехать вместе с
    // подписями оси — молча отрисовать его как сутки было бы враньём на графике.
    expect(() => visitsBreakdownSchema.parse({ ...realResponse, step: 'week' })).toThrow()
  })
})
