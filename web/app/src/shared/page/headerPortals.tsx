import { Fragment, isValidElement } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { House } from 'lucide-react'

import { useAppChromeSlots } from '../appChrome'
import { useWorkspaceAddress } from '../workspaceContext'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'

// Крошки страницы в верхнем баре. Каждый экран кабинета обязан их выставить: до
// этого бар был пустой полосой везде, кроме редактора и двух экранов пространств,
// а те рисовали три собственные копии почти одинаковой разметки.
//
// ПОСЛЕДНИЙ ЭЛЕМЕНТ — ТЕКУЩАЯ СТРАНИЦА и ссылкой не бывает; остальные передаются
// готовыми `<Link>`. Строка на непоследнем месте отрисуется как текст (asChild
// требует элемент), поэтому промежуточная крошка без ссылки — не ошибка, а
// осознанный «этап без своего экрана».
//
// КРОШКИ ДОВОДЯТ ДО СУЩНОСТИ, А НЕ ДО РАЗДЕЛА: у формы это «Пространство / Форма»,
// а «Ответы» или «Интеграции» показывает ряд табов под заголовком. Иначе путь и
// табы говорят одно и то же дважды.
export function PageCrumbs({ items }: { items: React.ReactNode[] }) {
  const { left } = useAppChromeSlots()
  // Дом — список форм ТЕКУЩЕГО пространства, а не общий: плоского списка форм в
  // кабинете нет, формы адресуются через пространство.
  const { slug } = useWorkspaceAddress()
  if (!left) return null

  // Дом добавляется ЗДЕСЬ, а не каждым экраном: он одинаков всюду, и передавать
  // его первым элементом означало бы повторить одну и ту же ссылку в десятке
  // мест — и однажды где-нибудь забыть.
  const trail: React.ReactNode[] = [
    <Link
      key="home"
      // Пустой slug — список пространств ещё не приехал; старый адрес остался
      // маршрутом-редиректом и дождётся его сам.
      {...(slug === ''
        ? { to: '/forms' as const }
        : { to: '/w/$workspaceSlug/forms' as const, params: { workspaceSlug: slug } })}
      aria-label="Главная"
    >
      <House className="size-4" />
    </Link>,
    ...items,
  ]

  return createPortal(
    <Breadcrumb className="min-w-0">
      {/* Крошки набраны ЧЕРНИЛАМИ — тем же тоном, что названия в разделах, — и
          средним весом: блёклые читались как выключенные. Спорить с заголовком им
          не даёт кегль — нижняя ступень шкалы. Кегля ВНЕ шкалы здесь стоять не
          должно: 13px не спорил ни с чем и именно поэтому выглядел чужим. */}
      <BreadcrumbList className="flex-nowrap gap-1.5 text-xs font-medium text-foreground sm:gap-1.5">
        {trail.map((item, i) => {
          const last = i === trail.length - 1
          return (
            <Fragment key={i}>
              <BreadcrumbItem className="min-w-0">
                {last ? (
                  <BreadcrumbPage className="truncate font-medium text-foreground">
                    {item}
                  </BreadcrumbPage>
                ) : isValidElement(item) ? (
                  <BreadcrumbLink asChild className="truncate">
                    {item}
                  </BreadcrumbLink>
                ) : (
                  <span className="truncate">{item}</span>
                )}
              </BreadcrumbItem>
              {!last && <BreadcrumbSeparator className="text-muted-foreground/40 [&>svg]:size-3" />}
            </Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>,
    left,
  )
}

// Действия НАД ОТКРЫТОЙ СУЩНОСТЬЮ в правой части бара: вход в редактор формы,
// «Копировать ссылку», «Параметры» расписания — а не отдельной панелью под шапкой.
//
// «Завести новое» сюда НЕ ставится (решение владельца 2026-09-07): оно относится к
// разделу, а не к открытому объекту, и живёт в `PageHeader actions` — вровень с
// названием раздела. Правило одно на весь кабинет, DESIGN-SYSTEM §1.
export function PageActions({ children }: { children: React.ReactNode }) {
  const { right } = useAppChromeSlots()
  if (!right) return null
  return createPortal(children, right)
}
