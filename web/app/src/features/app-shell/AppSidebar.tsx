import { Link, useRouterState } from '@tanstack/react-router'
import { CreditCard, FileText, LayoutTemplate, LogOut, Settings } from 'lucide-react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Презентационная оболочка кабинета. Данные пользователя и обработчики
// (создание формы, выход) прокидывает роут _app — сайдбар не тянет фичи напрямую.
//
// ТРИ ЯРУСА, И ПУНКТ ПОПАДАЕТ В ЯРУС ПО СВОЕМУ УРОВНЮ, А НЕ ПО ЧАСТОТЕ: вверху
// работа («Формы», «Шаблоны»), в середине контекст (пространства), внизу аккаунт
// (тариф, настройки, выход). «Тариф» и «Настройки» стояли в общем списке наравне
// с «Формами» и одновременно дублировались в нижнем меню — теперь они только внизу.
//
// СОЗДАНИЯ ФОРМЫ В САЙДБАРЕ НЕТ (решение владельца): форма заводится там, где видно,
// куда она ляжет, — кнопкой на дашборде и «плюсом» у пространства. Кнопка над
// навигацией называла место неявно, текущим пространством из адреса.
export interface AppSidebarProps {
  userEmail: string
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
  // workspacesNav — блок «Пространства» готовым узлом. Он читает список с сервера
  // и открывает окна состава, то есть тянет фичу, а сайдбар остаётся
  // презентационным: собирает его маршрут `_app`, как и остальные обработчики.
  workspacesNav: React.ReactNode
}

export function AppSidebar({
  userEmail,
  person,
  userName,
  onLogout,
  loggingOut,
  workspacesNav,
}: AppSidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const formsActive = pathname === '/forms' || pathname.startsWith('/forms/')
  const templatesActive = pathname.startsWith('/templates')

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

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={formsActive} tooltip="Формы">
                  <Link to="/forms">
                    <FileText className="size-4" />
                    <span>Формы</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={templatesActive} tooltip="Шаблоны">
                  <Link to="/templates">
                    <LayoutTemplate className="size-4" />
                    <span>Шаблоны</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {workspacesNav}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <UserAvatar person={person} />
                  <span className="truncate text-sm">{userName}</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
                  {userEmail}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/settings/plan">
                    <CreditCard className="size-4" />
                    Тариф
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/settings/account">
                    <Settings className="size-4" />
                    Настройки
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onLogout} disabled={loggingOut}>
                  <LogOut className="size-4" />
                  {loggingOut ? 'Выходим…' : 'Выйти'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
