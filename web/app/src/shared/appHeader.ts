import { createContext, useContext } from 'react'

// Верхний бар кабинета — ЕДИНСТВЕННАЯ шапка страницы. Слева путь (крошки), справа
// действия экрана; и то и другое страница отправляет туда порталом через
// `PageCrumbs`/`PageActions` (shared/page/headerPortals.tsx).
//
// Порталом, а не стейтом: портал попадает в тот же коммит React, что и сама
// страница, поэтому шапка не мигает пустой на первом кадре и не может
// рассинхронизироваться с содержимым. Контекст при этом сохраняется — роутер и
// Query внутри крошек работают, несмотря на другое место в DOM.
//
// Узлы кладёт `routes/_app.tsx`; до их появления (первый рендер) порталы молчат.
export interface AppHeaderSlots {
  left: HTMLElement | null
  right: HTMLElement | null
}

export const AppHeaderContext = createContext<AppHeaderSlots>({ left: null, right: null })

export const useAppHeaderSlots = (): AppHeaderSlots => useContext(AppHeaderContext)
