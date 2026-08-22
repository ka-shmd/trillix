import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import type { Workspace } from '../../entities/workspace'
import { UserAvatar } from '../../shared/UserAvatar'
import { membersQueryOptions } from './queries'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

// Сколько кружков помещается в кластер до «+N»: дальше он перестаёт читаться как
// «вот эти люди» и становится полосой.
const VISIBLE_AVATARS = 4

// MemberCluster — кружки участников у правого края строки пространства и вход в
// диалог состава. Само окно живёт у секции: открыть его может и меню «…», а два
// владельца одного состояния — два разных окна на один состав.
//
// Запрос состава тот же, что у диалога (общий ключ кэша), поэтому открытие окна
// не стоит второго обращения к серверу.
//
// Пространство может быть заморожено даунгрейдом — тогда состав не отдаётся вовсе.
// Кластер в этом случае показывает нейтральную кнопку: причину человек прочтёт
// в самом диалоге, и отнимать у него этот путь нельзя.
export function MemberCluster({
  workspace,
  onOpen,
}: {
  workspace: Workspace
  onOpen: () => void
}) {
  const state = useQuery(membersQueryOptions(workspace.id))

  if (state.isPending) {
    return <Skeleton className="h-7 w-16 rounded-full" aria-hidden="true" />
  }

  const members = state.data?.members ?? []
  const shown = members.slice(0, VISIBLE_AVATARS)
  const rest = members.length - shown.length

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 shrink-0 gap-1.5 px-2"
      onClick={onOpen}
      aria-haspopup="dialog"
    >
      {shown.length === 0 ? (
        <Users className="size-4 text-muted-foreground" />
      ) : (
        // -space-x-2 наезжает кружками друг на друга, кольцо цвета фона режет
        // стык — иначе соседние аватары сливаются в пятно.
        <span className="flex -space-x-2">
          {shown.map((m) => (
            <UserAvatar
              key={m.userId}
              person={m}
              className="size-6 rounded-full text-[10px] ring-2 ring-background"
            />
          ))}
        </span>
      )}
      {rest > 0 && <span className="text-xs text-muted-foreground">+{rest}</span>}
      <span className="sr-only">
        {members.length === 0
          ? `Участники пространства «${workspace.name}»`
          : `Участники пространства «${workspace.name}»: ${members.length}`}
      </span>
    </Button>
  )
}
