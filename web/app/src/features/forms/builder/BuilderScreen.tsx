import { useState } from 'react'

import { type FormDetail } from '../../../entities/form'
import { Canvas } from './Canvas'
import { Palette } from './Palette'
import { PreviewPane } from './PreviewPane'
import { SaveIndicator, ConflictBanner } from './SaveIndicator'
import { SettingsPanel } from './SettingsPanel'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { useAutosave } from './useAutosave'

type Mode = 'edit' | 'preview'

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
  const [mode, setMode] = useState<Mode>('edit')

  return (
    <BuilderStoreContext.Provider value={store}>
      {status === 'conflict' && <ConflictBanner />}
      <div className="builder-bar">
        <div className="builder-modes" role="group" aria-label="Режим">
          <button
            type="button"
            className={mode === 'edit' ? 'active' : ''}
            aria-pressed={mode === 'edit'}
            onClick={() => setMode('edit')}
          >
            Редактор
          </button>
          <button
            type="button"
            className={mode === 'preview' ? 'active' : ''}
            aria-pressed={mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            Превью
          </button>
        </div>
        <SaveIndicator status={status} onRetry={retry} />
      </div>
      {mode === 'edit' ? (
        <div className="builder">
          <Palette />
          <Canvas />
          <SettingsPanel />
        </div>
      ) : (
        <section className="builder-pane" aria-label="Превью формы">
          <PreviewPane />
        </section>
      )}
    </BuilderStoreContext.Provider>
  )
}
