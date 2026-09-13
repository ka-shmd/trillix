import type { Notification } from '../../entities/notification'

type Group = {
  id: string
  name: string
  items: Notification[]
}

// groupByWorkspace собирает строки по пространствам, СОХРАНЯЯ порядок ленты:
// сверху то, где случилось последнее. Сортировать группы по имени нельзя — тогда
// «Личное» уезжало бы вниз в самый нужный момент.
export function groupByWorkspace(items: Notification[]): Group[] {
  const groups: Group[] = []
  for (const item of items) {
    const group = groups.find((g) => g.id === item.workspaceId)
    if (group) {
      group.items.push(item)
      continue
    }
    groups.push({ id: item.workspaceId, name: item.workspaceName, items: [item] })
  }
  return groups
}

