import { createContext, useContext } from 'react'

// Слот действий в верхней шапке приложения (там же, где кнопка сворачивания
// сайдбара). Layout `_app` кладёт сюда DOM-узел, а страницы (напр. редактор формы)
// порталят в него свои кнопки — так все элементы управления живут в одном
// верхнем баре, а не в отдельной панели под ним.
export const HeaderSlotContext = createContext<HTMLElement | null>(null)

export const useHeaderSlot = (): HTMLElement | null => useContext(HeaderSlotContext)
