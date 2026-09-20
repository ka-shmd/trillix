import { describe, expect, it } from 'vitest'

import {
  appendSegments,
  MAX_SEGMENTS,
  segmentsFromSearch,
  segmentsToSearch,
  withSegment,
} from './segment'

// Условий разреза бывает несколько, и в адресе они лежат двумя видами: одно —
// строкой, несколько — массивом. Читать надо оба.
describe('segmentsFromSearch', () => {
  it('строку читает как одно условие, массив — как несколько', () => {
    expect(segmentsFromSearch('device:Телефон')).toEqual(['device:Телефон'])
    expect(segmentsFromSearch(['device:Телефон', 'source:vk.com'])).toEqual([
      'device:Телефон',
      'source:vk.com',
    ])
  })

  it('пустое и не-строки отбрасывает', () => {
    expect(segmentsFromSearch(undefined)).toEqual([])
    expect(segmentsFromSearch('')).toEqual([])
    expect(segmentsFromSearch(['device:Телефон', '', 7])).toEqual(['device:Телефон'])
  })

  // Потолок зеркалит domain.MaxSegments: сверх него сервер отвечает 422, и экран
  // ошибки вместо аналитики получался бы из подправленной руками ссылки.
  it('обрезает по потолку условий', () => {
    const many = Array.from({ length: MAX_SEGMENTS + 3 }, (_, i) => `device:${i}`)
    expect(segmentsFromSearch(many)).toHaveLength(MAX_SEGMENTS)
  })
})

// Обратно в адрес: одно условие — строкой, иначе ссылка «посмотри на это» выглядела
// бы как JSON-массив в процентных кодах.
describe('segmentsToSearch', () => {
  it('пусто — нет параметра, одно — строка, несколько — массив', () => {
    expect(segmentsToSearch([])).toBeUndefined()
    expect(segmentsToSearch(['device:Телефон'])).toBe('device:Телефон')
    expect(segmentsToSearch(['device:Телефон', 'source:vk.com'])).toEqual([
      'device:Телефон',
      'source:vk.com',
    ])
  })
})

// Условие на ИЗМЕРЕНИЕ одно: «устройство — телефон И устройство — планшет» не
// сужает выборку, а обнуляет её.
describe('withSegment', () => {
  it('условие по другому измерению добавляется', () => {
    expect(withSegment(['device:Телефон'], 'source', 'vk.com')).toEqual([
      'device:Телефон',
      'source:vk.com',
    ])
  })

  it('второе значение того же измерения заменяет первое', () => {
    expect(withSegment(['device:Телефон', 'source:vk.com'], 'device', 'Планшет')).toEqual([
      'source:vk.com',
      'device:Планшет',
    ])
  })

  it('то же самое условие снимается', () => {
    expect(withSegment(['device:Телефон', 'source:vk.com'], 'device', 'Телефон')).toEqual([
      'source:vk.com',
    ])
  })

  // Потолок равен числу измерений, поэтому «полный» список — это по условию на
  // каждое: добавлять больше нечего, а менять значения можно и на потолке.
  it('на потолке меняет значение, не удлиняя список', () => {
    const full = [
      'device:Телефон',
      'browser:Chrome',
      'os:iOS',
      'source:vk.com',
      'country:RU',
      'city:RU:Москва',
      'version:1',
    ]
    expect(full).toHaveLength(MAX_SEGMENTS)
    const next = withSegment(full, 'device', 'Планшет')
    expect(next).toHaveLength(MAX_SEGMENTS)
    expect(next).toContain('device:Планшет')
    expect(next).not.toContain('device:Телефон')
  })
})

describe('appendSegments', () => {
  // Параметр ПОВТОРЯЕТСЯ: domain.ParseSegments читает r.URL.Query()["segment"].
  it('каждое условие — свой параметр segment', () => {
    const params = appendSegments(new URLSearchParams({ from: 'x' }), [
      'device:Телефон',
      'source:vk.com',
    ])
    expect(params.getAll('segment')).toEqual(['device:Телефон', 'source:vk.com'])
    expect(params.get('from')).toBe('x')
  })

  it('без условий параметра нет', () => {
    expect(appendSegments(new URLSearchParams(), undefined).toString()).toBe('')
  })
})
