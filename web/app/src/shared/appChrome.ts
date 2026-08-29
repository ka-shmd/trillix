import { createContext, useContext } from 'react'

// Хром кабинета — ВЕРХНИЙ БАР И ПОДВАЛ, единственные на приложение. В баре слева
// путь (крошки), справа действия экрана; подвал — полоса у нижнего края под
// сохранение страницы. Всё это страница отправляет туда порталом через
// `PageCrumbs`/`PageActions` (shared/page/headerPortals.tsx) и `PageFooter`
// (shared/page/PageFooter.tsx).
//
// Порталом, а не стейтом: портал попадает в тот же коммит React, что и сама
// страница, поэтому хром не мигает пустым на первом кадре и не может
// рассинхронизироваться с содержимым. Контекст при этом сохраняется — роутер и
// Query внутри крошек работают, несмотря на другое место в DOM.
//
// Узлы кладёт `routes/_app.tsx`; до их появления (первый рендер) порталы молчат.
export interface AppChromeSlots {
  left: HTMLElement | null
  right: HTMLElement | null
  footer: HTMLElement | null
}

export const AppChromeContext = createContext<AppChromeSlots>({
  left: null,
  right: null,
  footer: null,
})

export const useAppChromeSlots = (): AppChromeSlots => useContext(AppChromeContext)
