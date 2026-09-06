import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Users } from 'lucide-react'
import type { Workspace } from '../../entities/workspace'
import { UserAvatar } from '../../shared/UserAvatar'
import { membersQueryOptions } from './queries'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

// Сколько кружков помещается в кластер до «+N»: дальше он перестаёт читаться как
// «вот эти люди» и становится полосой.
const VISIBLE_AVATARS = 4

// MemberCluster — кружки участников и ССЫЛКА на страницу состава
// (`/w/{slug}/members`). Ссылка, а не кнопка окна: состав стал разделом
// пространства, и второй способ его показать разъезжался бы с первым.
//
// Запрос состава тот же, что у страницы (общий ключ кэша), поэтому переход не
// стоит второго обращения к серверу.
//
// Пространство может быть заморожено даунгрейдом — тогда состав не отдаётся вовсе.
// Кластер в этом случае показывает нейтральный значок: причину человек прочтёт на
// самой странице, и отнимать у него этот путь нельзя.
export function MemberCluster({
  workspace,
  className,
}: {
  workspace: Workspace
  // className — подгонка под соседей по ряду. В баре формы кластер стоит рядом с
  // двумя текстовыми кнопками, и его боковые поля обязаны совпасть с их: при
  // равных зазорах между коробками разные внутренние поля дают разные зазоры
  // между тем, что видно, — ряд читается неровным.
  className?: string
}) {
  const state = useQuery(membersQueryOptions(workspace.id))

  if (state.isPending) {
    return <Skeleton className="h-8 w-14 rounded-full" aria-hidden="true" />
  }

  const members = state.data?.members ?? []
  const shown = members.slice(0, VISIBLE_AVATARS)
  const rest = members.length - shown.length

  return (
    <Button
      asChild
      variant="ghost"
      size="sm"
      className={cn('h-8 shrink-0 gap-1.5 px-2', className)}
    >
      <Link to="/w/$workspaceSlug/members" params={{ workspaceSlug: workspace.slug }}>
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
      </Link>
    </Button>
  )
}
