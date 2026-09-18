import { describe, expect, it } from 'vitest'
import { ApiError } from './errors'
import { consentRedirectFor, safeRedirect } from './consentGate'

describe('safeRedirect', () => {
  it.each([
    ['/w/abc/forms', '/w/abc/forms'],
    ['/join/tok?x=1', '/join/tok?x=1'],
    [undefined, '/'],
    ['', '/'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['/welcome', '/'],
    ['/welcome?redirect=/x', '/'],
  ])('%s → %s', (input, want) => {
    expect(safeRedirect(input)).toBe(want)
  })
})

describe('consentRedirectFor', () => {
  const gate = new ApiError(403, 'consent_required', 'consent required')
  const here = { pathname: '/w/abc/forms', href: '/w/abc/forms?tab=1' }

  it('уводит по consent_required с возвратом на текущий адрес', () => {
    expect(consentRedirectFor(gate, here)).toEqual({ redirect: '/w/abc/forms?tab=1' })
  })

  it('другой отказ не трогает', () => {
    expect(consentRedirectFor(new ApiError(403, 'forbidden', 'forbidden'), here)).toBeNull()
    expect(consentRedirectFor(new Error('Failed to fetch'), here)).toBeNull()
  })

  it('на самом экране согласия не уводит — иначе петля', () => {
    expect(consentRedirectFor(gate, { pathname: '/welcome', href: '/welcome?redirect=/x' })).toBeNull()
  })
})
