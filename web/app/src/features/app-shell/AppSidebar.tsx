import { Link, useRouterState } from '@tanstack/react-router'
import { LogOut, Settings } from 'lucide-react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { UserAvatar, type UserAvatarProps } from '../../shared/UserAvatar'
import { Button } from '@/components/ui/button'

// Презентационная оболочка кабинета. Данные пользователя и выход прокидывает роут
// `_app` — сайдбар не тянет фичи напрямую.
//
// ПУНКТ СТОИТ НА ТОМ УРОВНЕ, КОМУ ОН ПРИНАДЛЕЖИТ. Наверху — пространство и его
// разделы (`workspaceNav`), внизу — личное: настройки аккаунта и выход. Яруса «тип
// объекта» («Формы», «Шаблоны» рядом с пространствами) больше нет: почти всё в
// продукте принадлежит пространству, и ярус, притворявшийся глобальным, обязан был
// угадывать пространство из адреса — отсюда росли три дефекта сразу
// (спека `docs/design/cabinet-navigation.md`).
//
// МЕНЮ АККАУНТА РАСКРЫТО В ПАНЕЛЬ (решение владельца 2026-09-06). Оно держало три
// пункта, из которых «Тариф» аккаунту не принадлежал вовсе (он уехал в разделы
// пространства), а «Настройки» стоили клика по имени ради клика по пункту. Осталось
// два входа, и оба видны: строка «Настройки» и выход значком на строке имени.
//
// СОЗДАНИЯ ФОРМЫ В САЙДБАРЕ НЕТ (решение владельца): форма заводится там, где видно,
// куда она ляжет, — кнопкой на списке форм пространства.
export interface AppSidebarProps {
  // person — поля для кружка (картинка или инициалы). Отдельным пропом, а не
  // объектом User: сайдбар презентационный, и знать про пароли и второй фактор
  // ему незачем.
  person: UserAvatarProps['person']
  // userName — как звать человека: имя с фамилией, если он их указал, иначе
  // email (entities/user.ts, displayName). Считает вызывающий: сайдбар
  // презентационный и в фичи не ходит.
  userName: string
  onLogout: () => void
  loggingOut: boolean
  // workspaceNav — переключатель пространства и его разделы готовым узлом. Он читает
  // список с сервера и права, то есть тянет фичу, а сайдбар остаётся
  // презентационным: собирает его маршрут `_app` (импорт фичи из фичи запрещён,
  // web/CLAUDE.md).
  workspaceNav: React.ReactNode
}

export function AppSidebar({
  person,
  userName,
  onLogout,
  loggingOut,
  workspaceNav,
}: AppSidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    <Sidebar>
      {/* Высота шапки панели равна высоте верхнего бара (56px), а поля совпадают
          с его левым полем: логотип и крошки обязаны стоять на одной линии — они
          соседи по верхнему краю экрана, и разница в пару пикселей читается как
          съехавшая вёрстка. */}
      <SidebarHeader className="h-14 justify-center px-3 py-0">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-base font-bold tracking-tight">Trillix</span>
          {/* Свернуть — отсюда, из самой панели. Развернуть обратно отсюда нельзя:
              свёрнутая панель уезжает за экран целиком (collapsible=offcanvas), и
              кнопка уезжает вместе с ней. Обратно её возвращает та же кнопка,
              переехавшая в верхний бар (HeaderSidebarTrigger), — она появляется
              ровно в этом состоянии. Плюс Ctrl/Cmd+B. */}
          <SidebarTrigger className="text-muted-foreground" />
        </div>
      </SidebarHeader>

      <SidebarContent>{workspaceNav}</SidebarContent>

      <SidebarFooter>
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith('/settings')}
                  tooltip="Настройки"
                >
                  <Link to="/settings/account">
                    <Settings className="size-4" />
                    <span>Настройки</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Имя — ссылка в настройки аккаунта, выход — своя кнопка рядом.
                  Выход НЕ строка списка: он необратим одним нажатием, а строка в
                  ряду одинаковых строк нажимается по инерции. Значок с подписью для
                  скринридера — тот же приём, что у действий строки пространства. */}
              <SidebarMenuItem className="flex items-center gap-1">
                <SidebarMenuButton asChild size="lg" className="min-w-0 flex-1">
                  <Link to="/settings/account">
                    <UserAvatar person={person} />
                    <span className="truncate text-sm">{userName}</span>
                  </Link>
                </SidebarMenuButton>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground"
                  onClick={onLogout}
                  disabled={loggingOut}
                >
                  <LogOut className="size-4" />
                  <span className="sr-only">{loggingOut ? 'Выходим…' : 'Выйти'}</span>
                </Button>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarFooter>
    </Sidebar>
  )
}
