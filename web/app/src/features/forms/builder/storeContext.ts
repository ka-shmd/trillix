import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import { type StoreApi } from 'zustand/vanilla'

import { type BuilderStore } from './store'

// Контекст несёт vanilla-стор билдера, созданный на инстанс формы (BuilderScreen).
// Компонентов здесь нет намеренно — файл с одним контекстом и хуком не ломает
// fast-refresh (react-refresh/only-export-components срабатывает лишь при смеси
// компонентов и не-компонентов в одном файле).
export const BuilderStoreContext = createContext<StoreApi<BuilderStore> | null>(null)

// useBuilderStore подписывает компонент на срез стора. Действия — стабильные
// ссылки, их тоже безопасно выбирать этим хуком (перерисовки не вызывают).
export function useBuilderStore<T>(selector: (state: BuilderStore) => T): T {
  const store = useContext(BuilderStoreContext)
  if (!store) {
    throw new Error('useBuilderStore должен использоваться внутри BuilderScreen')
  }
  return useStore(store, selector)
}
