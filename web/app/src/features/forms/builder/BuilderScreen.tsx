import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { useStore } from 'zustand'
import { Eye, Pencil } from 'lucide-react'

import { type FormDetail } from '../../../entities/form'
import { useHeaderSlot } from '../../../shared/headerSlot'
import { PreviewPane } from './PreviewPane'
import { PublishControls } from './PublishControls'
import { SaveIndicator, ConflictBanner } from './SaveIndicator'
import { SlashEditor } from './SlashEditor'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { useAutosave } from './useAutosave'
import { Button } from '@/components/ui/button'

type Mode = 'edit' | 'preview'

// BuilderScreen — редактор в стиле Tally: чистое документное полотно (SlashEditor),
// а все элементы управления (статус сохранения, просмотр, публикация) порталятся в
// верхнюю шапку приложения — в один бар с кнопкой сворачивания сайдбара.
// Стор создаётся один раз на инстанс и сразу гидрируется черновиком; маршрут
// монтирует экран с key={formId}, поэтому переход на другую форму даёт свежий стор.
export function BuilderScreen({ detail }: { detail: FormDetail }) {
  const [store] = useState(() => {
    const s = createBuilderStore()
    s.getState().hydrate(detail.draftSchema)
    return s
  })

  const headerSlot = useHeaderSlot()
  const { status, retry } = useAutosave(store, detail.id, detail.updatedAt)
  const [mode, setMode] = useState<Mode>('edit')

  // Публиковать можно только когда серверный черновик догнал редактор: нет
  // несохранённых правок и последний автосейв успешен (иначе снапшот будет старым).
  const dirty = useStore(store, (s) => s.dirty)
  const canPublish = status === 'saved' && !dirty

  return (
    <BuilderStoreContext.Provider value={store}>
      {/* Кнопки редактора — в верхнюю шапку. Портал сохраняет React-контекст
          (стор/Query доступны), несмотря на другое место в DOM. */}
      {headerSlot &&
        createPortal(
          <div className="flex w-full items-center gap-2">
            <SaveIndicator status={status} onRetry={retry} />
            <div className="ml-auto flex items-center gap-2">
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
          </div>,
          headerSlot,
        )}

      {status === 'conflict' && <ConflictBanner />}

      {mode === 'edit' ? (
        <SlashEditor formId={detail.id} initialTitle={detail.title} />
      ) : (
        <section aria-label="Просмотр формы">
          <PreviewPane title={detail.title} />
        </section>
      )}
    </BuilderStoreContext.Provider>
  )
}
