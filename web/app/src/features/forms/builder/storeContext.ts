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
  return useStore(useBuilderStoreApi(), selector)
}

// useBuilderStoreApi — сам стор, без подписки. Нужен тем, кто читает документ ДО и
// ПОСЛЕ команды в одном обработчике (captionGuard): такому коду нужен getState в
// моменте, а не значение с прошлого рендера, и перерисовываться от чужих правок он
// не должен.
export function useBuilderStoreApi(): StoreApi<BuilderStore> {
  const store = useContext(BuilderStoreContext)
  if (!store) {
    throw new Error('useBuilderStore должен использоваться внутри BuilderScreen')
  }
  return store
}
