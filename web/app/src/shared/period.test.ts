import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_PERIOD, periodRange, periodSchema } from './period'

describe('окно наблюдения', () => {
  it('«всё время» не шлёт границ вовсе', () => {
    // Одно окно наблюдения — одно представление: пустой запрос сервер понимает
    // как ±бесконечность, и второй способ сказать то же самое не нужен.
    expect(periodRange('all')).toEqual({})
  })

  it('считает нижнюю границу от текущего момента', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T12:00:00Z'))
    try {
      expect(periodRange('24h')).toEqual({ from: '2026-08-23T12:00:00.000Z' })
      expect(periodRange('7d')).toEqual({ from: '2026-08-17T12:00:00.000Z' })
      expect(periodRange('30d')).toEqual({ from: '2026-07-25T12:00:00.000Z' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('верхней границы не ставит', () => {
    // Она была бы «сейчас» на момент сборки запроса, и визит, пришедший во время
    // загрузки страницы, выпадал бы из периода без всякой причины.
    expect(periodRange('7d').to).toBeUndefined()
  })

  it('мусор и пустота в адресе дают окно по умолчанию, а не роняют экран', () => {
    // Период приезжает из URL, то есть его правит человек. Единственный разумный
    // исход — открыть окно по умолчанию, а не белый экран. Непонятное окно и
    // неназванное — один случай, поэтому и значение у них одно.
    expect(periodSchema.parse('вчера')).toBe(DEFAULT_PERIOD)
    expect(periodSchema.parse(undefined)).toBe(DEFAULT_PERIOD)
  })

  // Экраны аналитики открываются на сутках: у формы, которая принимает ответы
  // прямо сейчас, вопрос «что происходит» чаще, чем «что было за всё время».
  it('по умолчанию — сутки', () => {
    expect(DEFAULT_PERIOD).toBe('24h')
  })
})
