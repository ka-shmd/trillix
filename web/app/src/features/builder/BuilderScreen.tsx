import { useState } from 'react'

import { type FormDetail } from '../../entities/form'
import { Canvas } from './Canvas'
import { Palette } from './Palette'
import { SettingsPanel } from './SettingsPanel'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'

// BuilderScreen — трёхколоночный каркас редактора: палитра / канвас / настройки.
// Стор создаётся один раз на инстанс и сразу гидрируется черновиком с сервера;
// маршрут монтирует экран с key={formId}, поэтому при переходе на другую форму
// экран пересоздаётся со свежим стором (несохранённые правки не перетекают).
export function BuilderScreen({ detail }: { detail: FormDetail }) {
  const [store] = useState(() => {
    const s = createBuilderStore()
    s.getState().hydrate(detail.draftSchema)
    return s
  })

  return (
    <BuilderStoreContext.Provider value={store}>
      <div className="builder">
        <Palette />
        <Canvas />
        <SettingsPanel />
      </div>
    </BuilderStoreContext.Provider>
  )
}
