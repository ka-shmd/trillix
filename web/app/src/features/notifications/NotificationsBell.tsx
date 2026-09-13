import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Bell, Check, MoreHorizontal, Trash2, X } from 'lucide-react'

import {
  notificationsQueryOptions,
  useDeleteAllNotifications,
  useDeleteNotification,
  useMarkNotificationsRead,
} from './queries'
import { groupByWorkspace } from './grouping'
import type { Notification } from '../../entities/notification'
import { formatRelativeDate } from '../../shared/format'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { LoadingRows } from '../../shared/page/states'
import { cn } from '@/lib/utils'

// NotificationsBell — пункт уведомлений в личном ярусе сайдбара. Именно там, а не
// в верхнем баре: бар у каждого экрана свой (у формы это путь и её действия, у
// расписания — почти ничего), и колокольчик посреди чужих кнопок читался бы
// действием страницы. Уведомления принадлежат ЧЕЛОВЕКУ, поэтому стоят рядом с
// «Тарифом» и «Аккаунтом» — пункт стоит на том уровне, кому он принадлежит.
//
// Рендерится строкой меню, поэтому живёт внутри <SidebarMenu> подвала.
export function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const feed = useQuery(notificationsQueryOptions)
  const markRead = useMarkNotificationsRead()
  const removeOne = useDeleteNotification()
  const removeAll = useDeleteAllNotifications()

  const unread = feed.data?.unread ?? 0
  const items = feed.data?.items ?? []
  const groups = groupByWorkspace(items)
  // Заголовок пространства показывается, только когда их несколько: у человека с
  // одним личным он повторял бы одно и то же над каждой строкой.
  const showWorkspace = groups.length > 1

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <SidebarMenuItem>
        <PopoverTrigger asChild>
          <SidebarMenuButton
            tooltip="Уведомления"
            aria-label={unread > 0 ? `Уведомления: непрочитанных ${unread}` : 'Уведомления'}
          >
            <span className="relative flex items-center">
              <Bell className="size-4" />
              {/* Точка на значке дублирует число сбоку и нужна ровно в свёрнутой
                панели: там строка ужимается до значка, а счётчик прячется своим
                `group-data-[collapsible=icon]:hidden`, и сигнал пропал бы вместе с
                ним. */}
              {unread > 0 && (
                <span
                  className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-highlight"
                  aria-hidden="true"
                />
              )}
            </span>
            <span>Уведомления</span>
          </SidebarMenuButton>
        </PopoverTrigger>
        {/* Число, а не точка: в панели для него есть место, а «сколько именно» —
          первое, что спрашивают. Трёхзначное жмётся в «99+».

          Цвет — ФУКСИЯ (решение владельца 2026-09-13), и пара взята та же, что у
          метки платной возможности: `--highlight-soft` под чернила
          `--highlight-bright`. Синий здесь обещал бы второе действие в строке,
          которая и так вся нажимается, а замеренный контраст пары держит AA —
          заливка на пике насыщенности под белым текстом его не держит. */}
        {unread > 0 && (
          <SidebarMenuBadge className="bg-highlight-soft text-highlight-bright">
            {unread > 99 ? '99+' : unread}
          </SidebarMenuBadge>
        )}
      </SidebarMenuItem>
      {/* Шторка открывается СБОКУ от панели: снизу она упёрлась бы в край окна —
        личный ярус и так стоит у нижней кромки. */}
      <PopoverContent
        side="right"
        align="end"
        // 28rem вместо прежних 22: строки поводов длинные («Заявка — CRM:
        // получатель не отвечает»), и на узкой шторке каждая вторая переносилась
        // на три строки. Потолок — доступная ширина от Radix: на узком экране
        // шторка сжимается, а не уезжает за край.
        className="w-112 max-w-(--radix-popover-content-available-width) p-0"
      >
        <div className="flex items-center gap-1 border-b px-3 py-2">
          <span className="flex-1 text-sm font-semibold">Уведомления</span>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="px-2 text-xs"
              onClick={() => markRead.mutate({ all: true })}
              disabled={markRead.isPending}
            >
              Прочитать всё
            </Button>
          )}
          {/* «Удалить все» уносит и непрочитанное: это решение человека, а не
            уборка по возрасту, и спрашивать «а точно?» у ленты, которая и так
            стирается сама через месяц, значило бы пугать на ровном месте. */}
          {items.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="px-2 text-xs"
              onClick={() => removeAll.mutate()}
              disabled={removeAll.isPending}
            >
              Удалить все
            </Button>
          )}
          {/* Крестик рядом с «Прочитать всё»: шторка закрывается и щелчком мимо, и
            Escape, но у пункта в панели промах мимо шторки попадает в соседнюю
            строку меню — и вместо закрытия человек уходит в «Тариф». */}
          <Button variant="ghost" size="icon" className="size-7" onClick={() => setOpen(false)}>
            <X className="size-4" />
            <span className="sr-only">Закрыть</span>
          </Button>
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
                  onRead={() => markRead.mutate({ ids: [item.id] })}
                  onDelete={() => removeOne.mutate(item.id)}
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
//
// СОБРАНА ПО ОБРАЗЦУ СТРОКИ СПИСКА ФОРМ, и это не подражание, а ответ на ту же
// задачу: строка нажимается целиком, а действие над ней — разрушающее. Там оно
// решено «⋯» внутри строки, и здесь решается так же (решение владельца
// 2026-09-13; до этого корзина стояла внутри строки голой кнопкой, а потом
// отдельной колонкой снаружи — первое не читалось кнопкой, второе выглядело
// чужим).
//
// Почему «⋯» снимает оба возражения: это знакомая точка входа, а не значок,
// который надо угадать; она стоит в строке, а не сбоку от неё; и удаление
// называется СЛОВОМ в меню, где деструктивный пункт отделён чертой.
//
// Ссылка растянута псевдоэлементом на всю строку (`after:absolute after:inset-0`),
// действия стоят выше по слою (`relative z-10`) — иначе накрывающий слой съедал бы
// клики по ним. Кнопка внутри ссылки недопустима разметкой, поэтому они соседи.
function NotificationRow({
  item,
  onOpen,
  onRead,
  onDelete,
}: {
  item: Notification
  onOpen: () => void
  onRead: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={cn(
        'relative flex items-start gap-2 rounded-md px-2 py-2 transition-colors',
        'hover:bg-accent/60 has-[a:focus-visible]:bg-accent/60',
      )}
    >
      <span
        className={cn(
          'mt-1.5 size-1.5 shrink-0 rounded-full',
          item.read ? 'bg-transparent' : 'bg-highlight',
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <Link
          to={item.link}
          onClick={onOpen}
          className={cn(
            'block text-sm after:absolute after:inset-0 after:rounded-md focus-visible:outline-none',
            item.read && 'text-muted-foreground',
          )}
        >
          {item.text}
        </Link>
        <span className="block text-xs text-muted-foreground">
          {formatRelativeDate(item.lastAt)}
        </span>
      </span>
      <div className="relative z-10 flex items-center text-muted-foreground">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 cursor-pointer text-muted-foreground"
              aria-label="Действия с уведомлением"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {/* Прочесть, не уходя по ссылке: прочтение ставит только нажатие
              (решение владельца), а нажать на строку значит уйти со шторки — для
              повода, который человек уже понял и без перехода, нужен этот пункт. */}
            {!item.read && (
              <DropdownMenuItem onSelect={onRead}>
                <Check className="size-4" />
                Отметить прочитанным
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="size-4" />
              Удалить
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
