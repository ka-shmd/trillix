import { describe, expect, it } from 'vitest'

import { slugFromPath } from './slug'

describe('slugFromPath', () => {
  it('достаёт slug из /r/{slug}', () => {
    expect(slugFromPath('/r/59LfFK0F4X')).toBe('59LfFK0F4X')
  })
  it('терпит завершающий слэш', () => {
    expect(slugFromPath('/r/abc/')).toBe('abc')
  })
  it('декодирует процент-кодировку', () => {
    expect(slugFromPath('/r/a%20b')).toBe('a b')
  })
  it('пустая строка для чужих путей', () => {
    expect(slugFromPath('/')).toBe('')
    expect(slugFromPath('/r/')).toBe('')
    expect(slugFromPath('/r/abc/extra')).toBe('')
    expect(slugFromPath('/other/abc')).toBe('')
  })
})
