import { Fragment, isValidElement } from 'react'
import { createPortal } from 'react-dom'

import { useAppHeaderSlots } from '../appHeader'
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
  const { left } = useAppHeaderSlots()
  if (!left) return null

  return createPortal(
    <Breadcrumb className="min-w-0">
      {/* Крошки набраны ЧЕРНИЛАМИ — тем же тоном, что названия в разделах, — и
          средним весом: блёклые читались как выключенные. Спорить с заголовком им
          не даёт кегль: 13px, единственный размер вне замороженной шкалы, потому
          что это хром бара, а не текст страницы. */}
      <BreadcrumbList className="flex-nowrap gap-1.5 text-[13px] font-medium text-foreground sm:gap-1.5">
        {items.map((item, i) => {
          const last = i === items.length - 1
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

// Действия экрана в правой части бара. Кнопки редактора, «Новое пространство» и
// т.п. живут здесь, а не отдельной панелью под шапкой.
export function PageActions({ children }: { children: React.ReactNode }) {
  const { right } = useAppHeaderSlots()
  if (!right) return null
  return createPortal(children, right)
}
