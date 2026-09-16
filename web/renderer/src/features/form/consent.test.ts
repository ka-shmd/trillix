import { describe, expect, it } from 'vitest'

import { documentFromPath, documentHref } from './consent'

describe('адрес документа согласия', () => {
  it('туда и обратно — slug и вид документа переживают разбор', () => {
    const href = documentHref('опрос 1', 'policy', '018f-rev', 3)
    const url = new URL(href, 'https://f.test')
    expect(documentFromPath(url.pathname)).toEqual({ slug: 'опрос 1', kind: 'policy' })
    expect(url.searchParams.get('revision')).toBe('018f-rev')
    expect(url.searchParams.get('version')).toBe('3')
  })

  it('чужой путь и неизвестный документ — не наш адрес', () => {
    expect(documentFromPath('/r/abc')).toBeNull()
    expect(documentFromPath('/documents/abc/offer')).toBeNull()
    expect(documentFromPath('/documents/abc')).toBeNull()
  })
})
