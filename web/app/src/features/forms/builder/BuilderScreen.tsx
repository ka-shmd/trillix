import { useState } from 'react'
import { useStore } from 'zustand'

import { type FormDetail } from '../../../entities/form'
import { PreviewPane } from './PreviewPane'
import { PublishControls } from './PublishControls'
import { SaveIndicator, ConflictBanner } from './SaveIndicator'
import { SlashEditor } from './SlashEditor'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { useAutosave } from './useAutosave'

type Mode = 'edit' | 'preview'

// BuilderScreen — каркас редактора в стиле Tally: единое полотно (SlashEditor)
// вместо палитры/канваса/панели. Стор создаётся один раз на инстанс и сразу
// гидрируется черновиком; маршрут монтирует экран с key={formId}, поэтому при
// переходе на другую форму экран пересоздаётся со свежим стором.
export function BuilderScreen({ detail }: { detail: FormDetail }) {
  const [store] = useState(() => {
    const s = createBuilderStore()
    s.getState().hydrate(detail.draftSchema)
    return s
  })

  const { status, retry } = useAutosave(store, detail.id, detail.updatedAt)
  const [mode, setMode] = useState<Mode>('edit')

  // Публиковать можно только когда серверный черновик догнал редактор: нет
  // несохранённых правок и последний автосейв успешен (иначе снапшот будет старым).
  const dirty = useStore(store, (s) => s.dirty)
  const canPublish = status === 'saved' && !dirty

  return (
    <BuilderStoreContext.Provider value={store}>
      {status === 'conflict' && <ConflictBanner />}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Режим">
          {(['edit', 'preview'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`rounded px-3 py-1 text-sm font-medium transition-colors ${
                mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {m === 'edit' ? 'Редактор' : 'Превью'}
            </button>
          ))}
        </div>
        <SaveIndicator status={status} onRetry={retry} />
      </div>

      <PublishControls form={detail} canPublish={canPublish} />

      {mode === 'edit' ? (
        <SlashEditor formId={detail.id} initialTitle={detail.title} />
      ) : (
        <section aria-label="Превью формы" className="mx-auto max-w-2xl px-4 py-8">
          <PreviewPane />
        </section>
      )}
    </BuilderStoreContext.Provider>
  )
}
