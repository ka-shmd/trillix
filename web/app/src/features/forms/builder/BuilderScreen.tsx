import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useStore } from 'zustand'
import { ArrowLeft, Eye, Pencil } from 'lucide-react'

import { type FormDetail } from '../../../entities/form'
import { PreviewPane } from './PreviewPane'
import { PublishControls } from './PublishControls'
import { SaveIndicator, ConflictBanner } from './SaveIndicator'
import { SlashEditor } from './SlashEditor'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { useAutosave } from './useAutosave'
import { Button } from '@/components/ui/button'

type Mode = 'edit' | 'preview'

// BuilderScreen — редактор в стиле Tally: тонкая липкая шапка (навигация, статус
// сохранения, просмотр, публикация) над чистым документным полотном (SlashEditor).
// Стор создаётся один раз на инстанс и сразу гидрируется черновиком; маршрут
// монтирует экран с key={formId}, поэтому переход на другую форму даёт свежий стор.
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

      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-background/80 px-3 py-1.5 backdrop-blur">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="gap-1 text-muted-foreground">
            <Link to="/forms">
              <ArrowLeft className="size-4" /> К формам
            </Link>
          </Button>
          <SaveIndicator status={status} onRetry={retry} />
        </div>

        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
            <Link to="/forms/$formId/responses" params={{ formId: detail.id }}>
              Ответы
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
          >
            {mode === 'edit' ? (
              <>
                <Eye className="size-4" /> Просмотр
              </>
            ) : (
              <>
                <Pencil className="size-4" /> Редактор
              </>
            )}
          </Button>
          <PublishControls form={detail} canPublish={canPublish} />
        </div>
      </div>

      {mode === 'edit' ? (
        <SlashEditor formId={detail.id} initialTitle={detail.title} />
      ) : (
        <section aria-label="Просмотр формы" className="mx-auto max-w-2xl px-6 py-10">
          <PreviewPane />
        </section>
      )}
    </BuilderStoreContext.Provider>
  )
}
