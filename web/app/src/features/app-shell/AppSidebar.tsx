import { Link, useRouterState } from '@tanstack/react-router'
import { CreditCard, FileText, LayoutGrid, LogOut, Plus, Settings } from 'lucide-react'
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
  onCreateForm: () => void
  creatingForm: boolean
  onLogout: () => void
  loggingOut: boolean
}

export function AppSidebar({
  userEmail,
  onCreateForm,
  creatingForm,
  onLogout,
  loggingOut,
}: AppSidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const formsActive = pathname === '/forms' || pathname.startsWith('/forms/')
  const planActive = pathname.startsWith('/settings/plan')
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
                <SidebarMenuButton disabled tooltip="Скоро">
                  <Settings className="size-4" />
                  <span>Настройки</span>
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
                    {userEmail.charAt(0).toUpperCase()}
                  </span>
                  <span className="truncate text-sm">{userEmail}</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
                  {userEmail}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
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
