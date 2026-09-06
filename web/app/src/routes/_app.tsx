import { createFileRoute, redirect, useNavigate, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { meQueryOptions, useLogout } from '../features/auth/queries'
import { displayName } from '../entities/user'
import { WorkspaceNav } from '../features/workspaces/WorkspaceNav'
import { workspacesQueryOptions } from '../features/workspaces/queries'
import { useMemo, useState } from 'react'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '../features/app-shell/AppSidebar'
import { HeaderSidebarTrigger } from '../features/app-shell/HeaderSidebarTrigger'
import { VerifyEmailBanner } from '../features/app-shell/VerifyEmailBanner'
import { AppChromeContext } from '../shared/appChrome'
import { WorkspaceAddressProvider } from '../shared/workspaceContext'

// Layout-группа приложения за сессией. Гард префетчит /auth/me; нет живой
// сессии → редирект на /login (защищённый маршрут не показывает контент).
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(meQueryOptions)
    } catch {
      throw redirect({ to: '/login' })
    }
  },
  component: AppLayout,
})

function AppLayout() {
  const navigate = useNavigate()
  const { data: user } = useQuery(meQueryOptions)
  // Личное пространство отдаётся оболочке ЗДЕСЬ, а не читается провайдером: список
  // пространств — хозяйство фичи, а `shared/` в фичи не ходит. Провайдеру нужно
  // одно — куда отступить, когда пространство не названо ни адресом, ни формой, ни
  // памятью браузера (первый вход, настройки аккаунта).
  const personal = useQuery({
    ...workspacesQueryOptions,
    select: (list) => list.find((w) => w.isPersonal)?.slug ?? null,
  })
  const logout = useLogout()
  // DOM-узлы хрома: две половины верхнего бара (слева путь, справа действия) и
  // подвал у нижнего края. Страницы порталят в них через PageCrumbs/PageActions
  // (shared/page/headerPortals.tsx) и PageFooter (shared/page/PageFooter.tsx).
  const [headerLeft, setHeaderLeft] = useState<HTMLElement | null>(null)
  const [headerRight, setHeaderRight] = useState<HTMLElement | null>(null)
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null)
  // Новый объект на каждый рендер оболочки перерисовывал бы каждую страницу с
  // крошками — контекст сравнивается по ссылке.
  const chromeSlots = useMemo(
    () => ({ left: headerLeft, right: headerRight, footer: footerSlot }),
    [headerLeft, headerRight, footerSlot],
  )

  // Гард гарантирует наличие user; на всякий случай не рендерим оболочку без него.
  if (!user) return null

  return (
    <WorkspaceAddressProvider personalSlug={personal.data ?? null}>
      <SidebarProvider>
        <AppSidebar
          person={user}
          userName={displayName(user)}
          onLogout={() => logout.mutate(undefined, { onSuccess: () => navigate({ to: '/login' }) })}
          loggingOut={logout.isPending}
          workspaceNav={<WorkspaceNav />}
        />
        {/* ОБОЛОЧКА СЪЕЗЖАЕТ ВМЕСТЕ С ВЫЕЗЖАЮЩЕЙ ШТОРКОЙ. Ширину открытой шторки
          кладёт в --app-drawer тот, кто её открыл (DesignDrawer); закрытая — 0px.
          Отступ здесь, а не на <main>: шапка sticky и лежит ВНУТРИ этой коробки,
          поэтому съезжает вместе с содержимым — иначе шторка накрывала бы её край,
          а полотно уезжало бы под панель. Заодно колонка формы сама
          перецентрируется в оставшейся ширине (mx-auto у полотна).
          Переменная на корне, а не проп через три слоя: шторку открывают глубоко в
          фиче, а съезжает оболочка маршрута — тот же приём, которым рендерер
          надевает тему на документ. */}
        <SidebarInset className="pr-(--app-drawer) transition-[padding-right] duration-300 ease-in-out">
          {/* Шапка зафиксирована (sticky): вся страница скроллится, а верхний бар
            остаётся на месте. z-20 — над контентом редактора, bg — чтобы контент
            не просвечивал под ней. */}
          <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background pr-2 pl-3">
            {/* Кнопка панели появляется здесь, только когда в самой панели её нажать
              негде: свёрнутая уезжает за экран, мобильная шторка закрыта. */}
            <HeaderSidebarTrigger />
            {/* Слева путь страницы, справа её действия. */}
            <div ref={setHeaderLeft} className="flex min-w-0 flex-1 items-center" />
            <div ref={setHeaderRight} className="flex shrink-0 items-center gap-2" />
          </header>
          {/* Отступы задаёт каждая страница сама: редактору нужен bleed, дашборду/
            ответам — обычные поля. */}
          <main className="flex-1 overflow-auto">
            {!user.emailVerified && <VerifyEmailBanner />}
            <AppChromeContext.Provider value={chromeSlots}>
              <Outlet />
            </AppChromeContext.Provider>
          </main>
          {/* Подвал страницы: полоса у нижнего края под одно действие — «Сохранить»
            настроек формы. Приклеен `sticky bottom-0`, а не `fixed`: скроллится
            вся страница (см. комментарий о шапке), а сама полоса живёт ВНУТРИ
            оболочки — поэтому она съезжает вместе с ней при открытой шторке и не
            накрывает боковую панель, как накрыл бы элемент, привязанный к окну.

            Пустая полоса скрыта: страниц с подвалом одна, и лишняя линия у
            нижнего края на всех остальных — не «почти незаметно», а второй
            горизонт в интерфейсе. */}
          <footer
            ref={setFooterSlot}
            className="sticky bottom-0 z-20 border-t bg-background empty:hidden"
          />
        </SidebarInset>
      </SidebarProvider>
    </WorkspaceAddressProvider>
  )
}
