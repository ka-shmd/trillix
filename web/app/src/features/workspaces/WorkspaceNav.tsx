import { useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarClock,
  Check,
  ChevronsUpDown,
  CreditCard,
  FileText,
  LayoutGrid,
  SquarePlus,
  Users,
} from 'lucide-react'

import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'
import { useCurrentWorkspace } from './current'
import { membersQueryOptions, workspacesQueryOptions } from './queries'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// Навигация кабинета — ПЕРЕКЛЮЧАТЕЛЬ ПРОСТРАНСТВА И ЕГО РАЗДЕЛЫ.
//
// Ярусов «по типу объекта» больше нет. Почти всё в продукте принадлежит
// пространству — формы, расписания, участники, квоты, — а верхний ярус притворялся
// глобальным и потому обязан был угадывать пространство из адреса. Отсюда росли три
// дефекта сразу: расписание команды уходило в личное, тариф команды был недостижим,
// форма из шаблона ложилась не туда (спека `docs/design/cabinet-navigation.md`).
//
// ПЕРЕКЛЮЧАТЕЛЬ, А НЕ ДЕРЕВО (решение владельца 2026-09-06). Сломано было понимание
// «где я», и переключатель делает текущее пространство постоянно видимым фактом;
// дерево — нет, а при трёх пространствах даёт двенадцать строк и слово «Формы»
// в панели трижды.
//
// СЧЁТЧИКОВ У РАЗДЕЛОВ НЕТ: `formCount` приезжает со списком бесплатно, но числа
// расписаний и участников стоили бы запроса на пространство (N+1, §6
// WORKSPACES.md), а один счётчик из четырёх читается как сбой остальных.
export function WorkspaceNav() {
  const workspaces = useQuery(workspacesQueryOptions)
  const current = useCurrentWorkspace()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [creating, setCreating] = useState(false)

  // Права спрашиваются ОДИН раз — у текущего пространства, и тем же запросом, каким
  // их читает страница участников (общий ключ кэша). Матрица прав живёт на сервере,
  // кабинет спрашивает действие, а не роль.
  const members = useQuery({
    ...membersQueryOptions(current?.id ?? ''),
    enabled: current !== undefined,
  })
  // ПОКА НЕ ЗНАЕМ — ПОКАЗЫВАЕМ. Тот же довод, что у гейтов тарифа
  // (`features/plan/useFeature.ts`): пункт, мигнувший и пропавший у владельца,
  // стоит дороже лишнего пункта у редактора, а настоящий отказ всё равно на бэке —
  // страница тарифа скажет о нём словами. Прячем только когда ЗНАЕМ, что нельзя.
  const showPlan = members.data ? members.data.permissions.includes('billing.view') : true

  if (!current) {
    return (
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {/* Список пространств ещё едет либо не приехал. Разделы без известного
                пространства нарисовать нечем: их адрес начинается с него. */}
            <SidebarMenuItem>
              <SidebarMenuSkeleton />
            </SidebarMenuItem>
            {workspaces.isError && (
              <SidebarMenuItem>
                <p role="alert" className="px-2 py-1 text-xs text-muted-foreground">
                  Не удалось загрузить пространства.
                </p>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    )
  }

  const slug = current.slug
  const section = pathname.slice(`/w/${slug}`.length)
  // «Формы» остаются подсвеченными и в галерее шаблонов: шаблон — способ начать
  // форму, а не отдельное место.
  const formsActive = section.startsWith('/forms') || section.startsWith('/templates')

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton className="data-[state=open]:bg-sidebar-accent">
                    <span className="min-w-0 flex-1 truncate font-medium">{current.name}</span>
                    <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
                >
                  {workspaces.data?.map((ws) => (
                    <DropdownMenuItem key={ws.id} asChild>
                      <Link to="/w/$workspaceSlug/forms" params={{ workspaceSlug: ws.slug }}>
                        <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                        {/* Галочка у текущего, а не подсветка строки: подсветка в
                            меню означает наведение, и два смысла у одного вида
                            читались бы как «выбрано то, на что навёл». */}
                        {ws.id === current.id && <Check className="size-4 shrink-0" />}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/workspaces">
                      <LayoutGrid className="size-4" />
                      Все пространства
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setCreating(true)}>
                    <SquarePlus className="size-4" />
                    Новое пространство
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={formsActive} tooltip="Формы">
                <Link to="/w/$workspaceSlug/forms" params={{ workspaceSlug: slug }}>
                  <FileText className="size-4" />
                  <span>Формы</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={section.startsWith('/schedules')}
                tooltip="Расписания"
              >
                <Link to="/w/$workspaceSlug/schedules" params={{ workspaceSlug: slug }}>
                  <CalendarClock className="size-4" />
                  <span>Расписания</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={section.startsWith('/members')}
                tooltip="Участники"
              >
                <Link to="/w/$workspaceSlug/members" params={{ workspaceSlug: slug }}>
                  <Users className="size-4" />
                  <span>Участники</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {showPlan && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={section.startsWith('/plan')} tooltip="Тариф">
                  <Link to="/w/$workspaceSlug/plan" params={{ workspaceSlug: slug }}>
                    <CreditCard className="size-4" />
                    <span>Тариф</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}
