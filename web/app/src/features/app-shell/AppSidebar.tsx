import { Link, useRouterState } from '@tanstack/react-router'
import {
  CreditCard,
  FileText,
  LayoutGrid,
  LayoutTemplate,
  LogOut,
  Plus,
  Settings,
} from 'lucide-react'
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
} from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
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
export interface AppSidebarProps {
  userEmail: string
  // userName — как звать человека: имя с фамилией, если он их указал, иначе
  // email (entities/user.ts, displayName). Считает вызывающий: сайдбар
  // презентационный и в фичи не ходит.
  userName: string
  onCreateForm: () => void
  creatingForm: boolean
  onLogout: () => void
  loggingOut: boolean
}

export function AppSidebar({
  userEmail,
  userName,
  onCreateForm,
  creatingForm,
  onLogout,
  loggingOut,
}: AppSidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const formsActive = pathname === '/forms' || pathname.startsWith('/forms/')
  const templatesActive = pathname.startsWith('/templates')
  const planActive = pathname.startsWith('/settings/plan')
  const accountActive = pathname.startsWith('/settings/account')
  const workspacesActive = pathname.startsWith('/workspaces')

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center px-2 py-1.5">
          <span className="text-lg font-bold tracking-tight">Trillix</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <Button
              className="w-full justify-start gap-2"
              onClick={onCreateForm}
              disabled={creatingForm}
            >
              <Plus className="size-4" />
              {creatingForm ? 'Создаём…' : 'Новая форма'}
            </Button>
          </SidebarGroupContent>
        </SidebarGroup>

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
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={workspacesActive} tooltip="Пространства">
                  <Link to="/workspaces">
                    <LayoutGrid className="size-4" />
                    <span>Пространства</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={planActive} tooltip="Тариф">
                  <Link to="/settings/plan">
                    <CreditCard className="size-4" />
                    <span>Тариф</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={accountActive} tooltip="Настройки">
                  <Link to="/settings/account">
                    <Settings className="size-4" />
                    <span>Настройки</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
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
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
                    {userName.charAt(0).toUpperCase()}
                  </span>
                  <span className="truncate text-sm">{userName}</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
                  {userEmail}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
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
