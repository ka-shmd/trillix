import { describe, expect, it } from 'vitest'
import { workspaceSlugFromLocation } from './currentWorkspace'

describe('workspaceSlugFromLocation', () => {
  it('без пространства в адресе — личное (пустая строка)', () => {
    expect(workspaceSlugFromLocation('/forms', {})).toBe('')
    expect(workspaceSlugFromLocation('/forms', { q: 'анкета' })).toBe('')
  })

  it('читает ?w= на любом маршруте', () => {
    expect(workspaceSlugFromLocation('/forms', { w: 'ws-1' })).toBe('ws-1')
    expect(workspaceSlugFromLocation('/forms/abc/edit', { w: 'ws-1' })).toBe('ws-1')
  })

  it('читает id из пути страницы пространства', () => {
    expect(workspaceSlugFromLocation('/workspaces/ws-1', {})).toBe('ws-1')
    expect(workspaceSlugFromLocation('/workspaces/ws-1/', {})).toBe('ws-1')
  })

  it('путь важнее ?w=: он и есть текущий экран', () => {
    expect(workspaceSlugFromLocation('/workspaces/ws-1', { w: 'ws-2' })).toBe('ws-1')
  })

  it('обзор пространств пространством не является', () => {
    expect(workspaceSlugFromLocation('/workspaces', {})).toBe('')
    expect(workspaceSlugFromLocation('/workspaces/', {})).toBe('')
  })

  it('мусор в ?w= не роняет разбор', () => {
    expect(workspaceSlugFromLocation('/forms', { w: 42 })).toBe('')
    expect(workspaceSlugFromLocation('/forms', { w: null })).toBe('')
  })
})
