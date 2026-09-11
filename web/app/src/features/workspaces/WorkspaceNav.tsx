import { useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarClock,
  Check,
  ChevronsUpDown,
  FileText,
  LayoutGrid,
  LayoutTemplate,
  Snowflake,
  SquarePlus,
  Users,
} from 'lucide-react'

import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'
import { useCurrentWorkspace } from './current'
import { workspacesQueryOptions } from './queries'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarSeparator,
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
// пространству — формы, расписания, участники, — а верхний ярус притворялся
// глобальным и потому обязан был угадывать пространство из адреса. Отсюда росли три
// дефекта сразу: расписание команды уходило в личное, тариф команды был недостижим,
// форма из шаблона ложилась не туда (спека `docs/design/cabinet-navigation.md`).
//
// ТАРИФ СЮДА НЕ ВХОДИТ (решение владельца 2026-09-06, ADR §10): он принадлежит
// АККАУНТУ, и разделом пространства обещал бы, что у пространства свой план. Пункт
// живёт в личном ярусе подвала, рядом с настройками (`AppSidebar`).
//
// ПЕРЕКЛЮЧАТЕЛЬ, А НЕ ДЕРЕВО (решение владельца 2026-09-06). Сломано было понимание
// «где я», и переключатель делает текущее пространство постоянно видимым фактом;
// дерево — нет, а при трёх пространствах даёт двенадцать строк и слово «Формы»
// в панели трижды.
//
// СЧЁТЧИКОВ У РАЗДЕЛОВ НЕТ: `formCount` приезжает со списком бесплатно, но числа
// расписаний и участников стоили бы запроса на пространство (N+1, §6
// WORKSPACES.md), а один счётчик из четырёх читается как сбой остальных.

// РАЗДЕЛЫ, В КОТОРЫЕ ПЕРЕКЛЮЧАТЕЛЬ ПЕРЕНОСИТ ЧЕЛОВЕКА КАК ЕСТЬ. Пространство
// меняют, поняв, что стоишь не в том месте, — раздел при этом менять не
// собирались, и увод на формы со списка расписаний заставлял возвращаться туда
// руками. Эти четыре адреса есть у любого пространства, поэтому переносятся.
//
// Ключ — ПЕРВЫЙ сегмент после пространства, без хвоста: «/schedules/42» и
// «/forms/opros/edit» называют предмет, которого в соседнем пространстве нет, и
// перенос идентификатора дал бы «нет такого». Незнакомый сегмент и адрес вне
// пространства отвечают формами.
const SECTIONS = {
  forms: '/w/$workspaceSlug/forms',
  templates: '/w/$workspaceSlug/templates',
  schedules: '/w/$workspaceSlug/schedules',
  members: '/w/$workspaceSlug/members',
} as const

function switchTarget(section: string) {
  const key = section.split('/')[1] ?? ''
  return key in SECTIONS ? SECTIONS[key as keyof typeof SECTIONS] : SECTIONS.forms
}

export function WorkspaceNav({ children }: { children?: React.ReactNode }) {
  const workspaces = useQuery(workspacesQueryOptions)
  const current = useCurrentWorkspace()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [creating, setCreating] = useState(false)

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
  const prefix = `/w/${slug}`
  // Раздел в адресе — «/schedules/42» на «/w/team/schedules/42». Вне пространства
  // (настройки, обзор пространств) раздела нет, и ответ — пустая строка: срез
  // префикса без этой проверки оставил бы от «/settings/account» произвольный
  // хвост, который может совпасть с именем раздела.
  const section =
    pathname === prefix || pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : ''
  const switchTo = switchTarget(section)

  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  {/* Переключатель обязан читаться МЕСТОМ, а не пятым пунктом списка:
                      квадрат с буквой пространства, имя в полный вес и подпись, чем оно
                      является. Пока строка отличалась от раздела одним шевроном, верх
                      панели не сообщал, где человек находится. */}
                  <SidebarMenuButton
                    size="lg"
                    tooltip={current.name}
                    className="data-[state=open]:bg-sidebar-accent"
                  >
                    {/* В свёрнутой полосе от переключателя остаётся буква
                        пространства: место обязано быть видно и там, а имя приезжает
                        подсказкой. */}
                    <WorkspaceMark name={current.name} frozen={current.frozen} />
                    <span className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                      <span className="truncate text-sm font-semibold">{current.name}</span>
                      {/* Заморозка говорится ВМЕСТО вида пространства, а не рядом:
                          «Командное · закрыто» — два факта в строке, из которых
                          важен один, и важный стоит вторым. */}
                      <span className="truncate text-xs text-muted-foreground">
                        {current.frozen
                          ? 'Закрыто — тариф'
                          : current.isPersonal
                            ? 'Личное'
                            : 'Командное'}
                      </span>
                    </span>
                    <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
                >
                  {workspaces.data?.map((ws) => (
                    <DropdownMenuItem key={ws.id} asChild>
                      <Link to={switchTo} params={{ workspaceSlug: ws.slug }}>
                        <WorkspaceMark name={ws.name} frozen={ws.frozen} />
                        <span
                          className={`min-w-0 flex-1 truncate ${ws.frozen ? 'text-muted-foreground' : ''}`}
                        >
                          {ws.name}
                        </span>
                        {/* Снежинка у закрытого: пометка обязана быть ДО входа —
                            иначе человек узнаёт о состоянии, только упёршись в
                            отказ на каждом экране внутри. */}
                        {ws.frozen && (
                          <Snowflake className="size-4 shrink-0 text-muted-foreground" />
                        )}
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

      {/* Разделитель, а не отступ: три яруса панели (место, его разделы, личное) были
          тремя группами только в разметке — на экране они шли одной лентой одинаковых
          строк. */}
      <SidebarSeparator />

      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {/* Поиск стоит НАД разделами и вне пространства: он единственный, кто
                пространства не выбирает, — ищет по всем сразу. Отдаёт его маршрут
                `_app` (импорт фичи из фичи запрещён, web/CLAUDE.md). */}
            {children}
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={section.startsWith('/forms')} tooltip="Формы">
                <Link to="/w/$workspaceSlug/forms" params={{ workspaceSlug: slug }}>
                  <FileText className="size-4" />
                  <span>Формы</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {/* Галерея шаблонов — раздел пространства (решение владельца
                2026-09-07), и адрес у неё пространственный: форма из шаблона
                ложится туда, куда указывает путь, а не всегда в личное. Стоит
                сразу под формами: это второй способ их завести. */}
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={section.startsWith('/templates')}
                tooltip="Шаблоны"
              >
                <Link to="/w/$workspaceSlug/templates" params={{ workspaceSlug: slug }}>
                  <LayoutTemplate className="size-4" />
                  <span>Шаблоны</span>
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
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

// Квадрат с первой буквой пространства — та же роль, что у инициалов в аватарке
// человека: место опознаётся пятном раньше, чем читается имя. И это единственное
// применение акцента в панели помимо выбранного раздела.
function WorkspaceMark({ name, frozen }: { name: string; frozen?: boolean }) {
  return (
    <span
      aria-hidden="true"
      // Закрытое пространство теряет акцент: акцентом красится то, во что можно
      // войти и работать, а здесь нельзя ни того, ни другого.
      className={`flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${
        frozen
          ? 'bg-muted text-muted-foreground'
          : 'bg-sidebar-primary text-sidebar-primary-foreground'
      }`}
    >
      {[...name.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  )
}
