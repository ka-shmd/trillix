import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Bell } from 'lucide-react'

import { notificationsQueryOptions, useMarkNotificationsRead } from './queries'
import { groupByWorkspace } from './grouping'
import type { Notification } from '../../entities/notification'
import { formatRelativeDate } from '../../shared/format'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LoadingRows } from '../../shared/page/states'
import { cn } from '@/lib/utils'

// NotificationsBell — колокольчик верхнего бара. Элемент ОБОЛОЧКИ, а не портал
// действий страницы: портал принадлежит экрану, а колокольчик — человеку, и виден
// он на всех экранах разом.
export function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const feed = useQuery(notificationsQueryOptions)
  const markRead = useMarkNotificationsRead()

  const unread = feed.data?.unread ?? 0
  const items = feed.data?.items ?? []
  const groups = groupByWorkspace(items)
  // Заголовок пространства показывается, только когда их несколько: у человека с
  // одним личным он повторял бы одно и то же над каждой строкой.
  const showWorkspace = groups.length > 1

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread > 0 ? `Уведомления: непрочитанных ${unread}` : 'Уведомления'}
        >
          <Bell className="size-4" />
          {unread > 0 && (
            // Точка, а не число: в баре важно «есть новое», а сколько именно —
            // видно в самой шторке, и двузначное число здесь пришлось бы жать.
            <span
              className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-background"
              aria-hidden="true"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-88 p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-sm font-semibold">Уведомления</span>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => markRead.mutate({ all: true })}
              disabled={markRead.isPending}
            >
              Прочитать всё
            </Button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto p-2">
          {feed.isPending && <LoadingRows rows={2} />}
          {feed.isError && (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              Не удалось загрузить уведомления.
            </p>
          )}
          {!feed.isPending && !feed.isError && items.length === 0 && (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              Пока ничего не произошло.
            </p>
          )}
          {groups.map((group) => (
            <div key={group.id} className="mb-1 last:mb-0">
              {showWorkspace && (
                <p className="px-2 py-1 text-xs text-muted-foreground">{group.name}</p>
              )}
              {group.items.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  onOpen={() => {
                    setOpen(false)
                    if (!item.read) markRead.mutate({ ids: [item.id] })
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// NotificationRow — строка ленты. Текст и адрес пришли готовыми с сервера: экран
// решает только, как их показать.
function NotificationRow({ item, onOpen }: { item: Notification; onOpen: () => void }) {
  return (
    <Link
      to={item.link}
      onClick={onOpen}
      className={cn(
        'flex items-start gap-2 rounded-md px-2 py-2 transition-colors',
        'hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none',
      )}
    >
      <span
        className={cn(
          'mt-1.5 size-1.5 shrink-0 rounded-full',
          item.read ? 'bg-transparent' : 'bg-primary',
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm', item.read && 'text-muted-foreground')}>
          {item.text}
        </span>
        <span className="block text-xs text-muted-foreground">
          {formatRelativeDate(item.lastAt)}
        </span>
      </span>
    </Link>
  )
}
