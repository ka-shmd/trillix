import { useState } from 'react'

import { type FormDetail } from '../../../entities/form'
import { Canvas } from './Canvas'
import { Palette } from './Palette'
import { SaveIndicator, ConflictBanner } from './SaveIndicator'
import { SettingsPanel } from './SettingsPanel'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { useAutosave } from './useAutosave'

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

  const { status, retry } = useAutosave(store, detail.id, detail.updatedAt)

  return (
    <BuilderStoreContext.Provider value={store}>
      {status === 'conflict' && <ConflictBanner />}
      <div className="builder-bar">
        <SaveIndicator status={status} onRetry={retry} />
      </div>
      <div className="builder">
        <Palette />
        <Canvas />
        <SettingsPanel />
      </div>
    </BuilderStoreContext.Provider>
  )
}
