import { describe, expect, it } from 'vitest'

import { consentToSend, documentFromPath, documentHref } from './consent'

describe('адрес документа согласия', () => {
  it('туда и обратно — slug и вид документа переживают разбор', () => {
    const href = documentHref('опрос 1', 'policy', '018f-rev')
    const url = new URL(href, 'https://f.test')
    expect(documentFromPath(url.pathname)).toEqual({ slug: 'опрос 1', kind: 'policy' })
    expect(url.searchParams.get('revision')).toBe('018f-rev')
    expect(url.searchParams.has('version')).toBe(false)
  })

  it('ревизия уходит с ответом только при отмеченной галочке', () => {
    expect(consentToSend('018f-rev', true)).toBe('018f-rev')
    expect(consentToSend('018f-rev', false)).toBe('')
    expect(consentToSend(null, true)).toBe('')
  })

  it('чужой путь и неизвестный документ — не наш адрес', () => {
    expect(documentFromPath('/r/abc')).toBeNull()
    expect(documentFromPath('/documents/abc/offer')).toBeNull()
    expect(documentFromPath('/documents/abc')).toBeNull()
  })
})
