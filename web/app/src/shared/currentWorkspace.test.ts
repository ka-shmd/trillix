import { describe, expect, it } from 'vitest'
import { workspaceSlugFromPath } from './currentWorkspace'

describe('workspaceSlugFromPath', () => {
  it('читает пространство из корня раздела', () => {
    expect(workspaceSlugFromPath('/w/ws-1')).toBe('ws-1')
    expect(workspaceSlugFromPath('/w/ws-1/')).toBe('ws-1')
  })

  it('читает пространство на любой глубине раздела', () => {
    expect(workspaceSlugFromPath('/w/ws-1/forms')).toBe('ws-1')
    expect(workspaceSlugFromPath('/w/ws-1/schedules/018f-abc')).toBe('ws-1')
    expect(workspaceSlugFromPath('/w/ws-1/forms/abc/edit')).toBe('ws-1')
  })

  it('раскодирует slug из адреса', () => {
    expect(workspaceSlugFromPath('/w/ws%201/forms')).toBe('ws 1')
  })

  // `null`, а не пустая строка: «путь пространства не называет» и «названо пустое» —
  // разные новости, и вторая невозможна. Отличать их обязан вызывающий: по
  // неназванному отвечает память оболочки, а по названному — только оно само.
  it('адрес без пространства — null, а не пустая строка', () => {
    expect(workspaceSlugFromPath('/forms/abc/share')).toBeNull()
    expect(workspaceSlugFromPath('/settings/account')).toBeNull()
    expect(workspaceSlugFromPath('/workspaces')).toBeNull()
    expect(workspaceSlugFromPath('/')).toBeNull()
  })

  // Корень `/w` без slug'а — не пространство: маршрута с таким адресом нет, и
  // прочитать из него имя нечего.
  it('корень /w пространством не является', () => {
    expect(workspaceSlugFromPath('/w')).toBeNull()
    expect(workspaceSlugFromPath('/w/')).toBeNull()
  })
})
