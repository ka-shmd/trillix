import { describe, expect, it } from 'vitest'
import { workspaceIdFromLocation } from './currentWorkspace'

describe('workspaceIdFromLocation', () => {
  it('без пространства в адресе — личное (пустая строка)', () => {
    expect(workspaceIdFromLocation('/forms', {})).toBe('')
    expect(workspaceIdFromLocation('/forms', { q: 'анкета' })).toBe('')
  })

  it('читает ?w= на любом маршруте', () => {
    expect(workspaceIdFromLocation('/forms', { w: 'ws-1' })).toBe('ws-1')
    expect(workspaceIdFromLocation('/forms/abc/edit', { w: 'ws-1' })).toBe('ws-1')
  })

  it('читает id из пути страницы пространства', () => {
    expect(workspaceIdFromLocation('/workspaces/ws-1', {})).toBe('ws-1')
    expect(workspaceIdFromLocation('/workspaces/ws-1/', {})).toBe('ws-1')
  })

  it('путь важнее ?w=: он и есть текущий экран', () => {
    expect(workspaceIdFromLocation('/workspaces/ws-1', { w: 'ws-2' })).toBe('ws-1')
  })

  it('обзор пространств пространством не является', () => {
    expect(workspaceIdFromLocation('/workspaces', {})).toBe('')
    expect(workspaceIdFromLocation('/workspaces/', {})).toBe('')
  })

  it('мусор в ?w= не роняет разбор', () => {
    expect(workspaceIdFromLocation('/forms', { w: 42 })).toBe('')
    expect(workspaceIdFromLocation('/forms', { w: null })).toBe('')
  })
})
