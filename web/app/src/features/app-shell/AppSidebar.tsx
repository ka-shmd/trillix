import { Link, useRouterState } from '@tanstack/react-router'
import { CreditCard, LogOut, Settings } from 'lucide-react'

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
  SidebarSeparator,
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
// МЕНЮ АККАУНТА РАСКРЫТО В ПАНЕЛЬ (решение владельца 2026-09-06): настройки
// стоили клика по имени ради клика по пункту. Входы видны строками, выход — значком
// на строке имени.
//
// «ТАРИФ» СТОИТ ИМЕННО ЗДЕСЬ, а не в разделах пространства (решение владельца
// 2026-09-06, ADR §10). Подписку покупает АККАУНТ: один план накрывает все его
// пространства. Пока пункт стоял разделом, он обещал у каждого пространства свой
// тариф — и страница это обещание подтверждала, показывая на каждом свой остаток
// сообщений ассистенту, потому что счётчик тоже был воркспейсным.
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
  // notifications — пункт уведомлений готовой строкой меню, по тому же доводу, что
  // workspaceNav: он ходит на сервер за лентой, а сайдбар остаётся презентационным.
  notifications: React.ReactNode
}

export function AppSidebar({
  person,
  userName,
  onLogout,
  loggingOut,
  workspaceNav,
  notifications,
}: AppSidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    // СВЁРНУТАЯ ПАНЕЛЬ ОСТАЁТСЯ ПОЛОСОЙ ЗНАЧКОВ, а не уезжает за экран
    // (`collapsible=icon`, решение владельца 2026-09-06). Полоса читается, потому что
    // значок есть у КАЖДОГО раздела: место остаётся видимым буквой пространства, а
    // имя раздела приезжает подсказкой. Заводишь раздел без значка — полоса на нём
    // становится пустым местом.
    <Sidebar collapsible="icon">
      {/* Высота шапки панели равна высоте верхнего бара (48px), а поля совпадают
          с его левым полем: логотип и крошки обязаны стоять на одной линии — они
          соседи по верхнему краю экрана, и разница в пару пикселей читается как
          съехавшая вёрстка. */}
      <SidebarHeader className="h-12 justify-center px-3 py-0 group-data-[collapsible=icon]:px-0">
        <div className="flex items-center justify-center gap-2">
          <span className="flex-1 text-base font-bold tracking-tight group-data-[collapsible=icon]:hidden">
            Trillix
          </span>
          {/* Свернуть и развернуть — обе отсюда: полоса значков остаётся на экране
              вместе со своей кнопкой. В верхнем баре кнопка нужна только на
              мобильном, где панель — закрытая шторка (HeaderSidebarTrigger). Плюс
              Ctrl/Cmd+B. */}
          <SidebarTrigger className="text-muted-foreground" />
        </div>
      </SidebarHeader>

      <SidebarContent>{workspaceNav}</SidebarContent>

      {/* Личный ярус отделён линией, а не отступом: без неё «Настройки» читались
          пятым разделом пространства, а скачок роста у строки аккаунта (48px против
          32px в списке выше) — сбоем вёрстки. */}
      <SidebarSeparator />

      <SidebarFooter>
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu>
              {/* Уведомления — первыми в личном ярусе: это не адрес, а состояние,
                  и смотрят на них чаще, чем заходят в тариф и настройки. Пункт
                  открывает шторку, а не страницу, поэтому стоит перед ссылками. */}
              {notifications}

              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith('/settings/plan')}
                  tooltip="Тариф"
                >
                  <Link to="/settings/plan">
                    <CreditCard className="size-4" />
                    <span>Тариф</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Тариф живёт по адресу настроек, но пунктом стоит своим, поэтому
                  «Аккаунт» подсвечивается всем разделом КРОМЕ него: иначе на
                  странице тарифа горели бы обе строки сразу.

                  ПУНКТ НАЗВАН «Аккаунт», как названы страница и её крошка. Пока он
                  звался «Настройки», одна страница имела три разных имени, а слово
                  ничего не различало: «Тариф» над ним — тоже настройка аккаунта. */}
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={
                    pathname.startsWith('/settings') && !pathname.startsWith('/settings/plan')
                  }
                  tooltip="Аккаунт"
                >
                  <Link to="/settings/account">
                    <Settings className="size-4" />
                    <span>Аккаунт</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>

              {/* Имя — ссылка в настройки аккаунта, выход — своя кнопка рядом.
                  Выход НЕ строка списка: он необратим одним нажатием, а строка в
                  ряду одинаковых строк нажимается по инерции. Значок с подписью для
                  скринридера — тот же приём, что у действий строки пространства. */}
              <SidebarMenuItem className="flex items-center gap-1">
                <SidebarMenuButton asChild size="lg" className="min-w-0 flex-1" tooltip={userName}>
                  <Link to="/settings/account">
                    <UserAvatar person={person} />
                    <span className="truncate text-sm group-data-[collapsible=icon]:hidden">
                      {userName}
                    </span>
                  </Link>
                </SidebarMenuButton>
                {/* В свёрнутой полосе выхода нет: две кнопки в 48px не помещаются, а
                    ужимать до значка без подписи действие, которое одним нажатием
                    заканчивает сеанс, — плохой размен. Разворачивается панель
                    Ctrl/Cmd+B либо кнопкой в её шапке. */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
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
