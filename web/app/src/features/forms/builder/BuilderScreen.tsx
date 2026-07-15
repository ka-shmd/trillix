import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { useStore } from 'zustand'
import { Eye, Pencil, Redo2, Undo2 } from 'lucide-react'

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

  const canUndo = useStore(store, (s) => s.past.length > 0)
  const canRedo = useStore(store, (s) => s.future.length > 0)

  // Горячие клавиши истории на весь экран билдера: Ctrl/Cmd+Z — отмена,
  // Ctrl/Cmd+Shift+Z и Ctrl+Y — повтор. Слушатель живёт вместе с экраном; на
  // документ-уровне перехватываем и внутри textarea (нативный undo поля уступает
  // отмене всего документа — так ведёт себя Notion/Tally). Пустой стек — no-op.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return
      // Сверяем физическую клавишу (e.code), а не e.key: при кириллической (и любой
      // не-латинской) раскладке Ctrl+Z даёт e.key='я', и хоткей молча ломался —
      // срабатывал нативный undo контролируемого textarea (откат по одному символу).
      if (e.code !== 'KeyZ' && e.code !== 'KeyY') return
      // Поля со своей историей (название формы — серверный rename вне стора билдера)
      // откатываются нативным undo браузера: их не перехватываем.
      if ((e.target as HTMLElement | null)?.closest('[data-undo-native]')) return
      if (e.code === 'KeyZ' && !e.shiftKey) {
        e.preventDefault()
        store.getState().undo()
      } else {
        e.preventDefault()
        store.getState().redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

  return (
    <BuilderStoreContext.Provider value={store}>
      {/* Кнопки редактора — в верхнюю шапку. Портал сохраняет React-контекст
          (стор/Query доступны), несмотря на другое место в DOM. */}
      {headerSlot &&
        createPortal(
          <div className="flex w-full items-center gap-2">
            <SaveIndicator status={status} onRetry={retry} />
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                disabled={!canUndo}
                onClick={() => store.getState().undo()}
                aria-label="Отменить (Ctrl+Z)"
                title="Отменить (Ctrl+Z)"
              >
                <Undo2 className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                disabled={!canRedo}
                onClick={() => store.getState().redo()}
                aria-label="Повторить (Ctrl+Shift+Z)"
                title="Повторить (Ctrl+Shift+Z)"
              >
                <Redo2 className="size-4" />
              </Button>
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
