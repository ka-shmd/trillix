import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useStore } from 'zustand'
import { ChevronRight, Eye, House, Pencil, Redo2, Settings, Undo2 } from 'lucide-react'

import { displayFormName, type FormDetail } from '../../../entities/form'
import { workspacesQueryOptions } from '../../workspaces/queries'
import { useHeaderSlot } from '../../../shared/headerSlot'
import { FormSettings } from './FormSettings'
import { PreviewPane } from './PreviewPane'
import { PublishControls } from './PublishControls'
import { SaveIndicator, ConflictBanner } from './SaveIndicator'
import { SlashEditor } from './SlashEditor'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { useAutosave } from './useAutosave'
import { Button } from '@/components/ui/button'

// Что показано вместо полотна. Полотно (edit) — документ из блоков; превью — как
// увидит респондент; настройки — то, чего на форме не видно (экран после отправки).
// Режим локальный: F5 возвращает в редактор, ссылки на превью/настройки нет — по
// тому же принципу, что и превью с самого начала (решение владельца).
type Mode = 'edit' | 'preview' | 'settings'

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
  const { status, saveNow } = useAutosave(store, detail.id, detail.slug, detail.updatedAt)
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
            <Breadcrumbs formName={displayFormName(detail)} />
            <div className="ml-auto flex items-center gap-2">
              <SaveIndicator status={status} onRetry={saveNow} />
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
                <Link to="/forms/$slug/responses" params={{ slug: detail.slug }}>
                  Ответы
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => setMode((m) => (m === 'preview' ? 'edit' : 'preview'))}
              >
                {mode === 'preview' ? (
                  <>
                    <Pencil className="size-4" /> Редактор
                  </>
                ) : (
                  <>
                    <Eye className="size-4" /> Просмотр
                  </>
                )}
              </Button>
              {/* Настройки формы — только вход, не тумблер: назад уводит кнопка на
                  самой странице. Тумблер здесь был бы вторым выходом мимо диалога
                  о несохранённых правках — и неочевидным (по иконке не догадаться,
                  что нажать её надо ещё раз). Иконка, а не текст: место в шапке
                  кончается, а сама страница подписана заголовком. */}
              <Button
                variant="ghost"
                size="icon-sm"
                className={mode === 'settings' ? '' : 'text-muted-foreground'}
                aria-pressed={mode === 'settings'}
                onClick={() => setMode('settings')}
                aria-label="Настройки формы"
                title="Настройки формы"
              >
                <Settings className="size-4" />
              </Button>
              <PublishControls form={detail} canPublish={canPublish} />
            </div>
          </div>,
          headerSlot,
        )}

      {status === 'conflict' && <ConflictBanner />}

      {mode === 'edit' && <SlashEditor formId={detail.id} initialTitle={detail.title} />}
      {mode === 'preview' && (
        <section aria-label="Просмотр формы">
          <PreviewPane title={detail.title} />
        </section>
      )}
      {/* Настройки сохраняются кнопкой, а не автосейвом: saveNow уносит их сразу,
          иначе индикатор ещё 800 мс дебаунса врал бы «не сохранено». */}
      {mode === 'settings' && <FormSettings onBack={() => setMode('edit')} onSaved={saveNow} />}
    </BuilderStoreContext.Provider>
  )
}

// Breadcrumbs — путь над редактором: Дом (дашборд форм) → пространство → форма.
// Имя воркспейса — серверный стейт из Query (в MVP один личный); пока не
// подгрузилось, крошка пространства не рисуется, чтобы не мигать пустотой.
// Пространство и текущая форма — не ссылки: страницы пространства пока нет, а
// форма — текущая. Длинные имена усекаются, шапку не распирают.
function Breadcrumbs({ formName }: { formName: string }) {
  const { data: workspaces } = useQuery(workspacesQueryOptions)
  const workspaceName = workspaces?.[0]?.name

  return (
    <nav aria-label="Хлебные крошки" className="flex min-w-0 items-center gap-1 text-sm">
      <Link
        to="/forms"
        aria-label="Дом"
        className="flex shrink-0 items-center text-muted-foreground hover:text-foreground"
      >
        <House className="size-4" />
      </Link>
      {workspaceName && (
        <>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
          <span className="max-w-[16ch] shrink-0 truncate text-muted-foreground">
            {workspaceName}
          </span>
        </>
      )}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
      <span className="min-w-0 truncate font-medium" aria-current="page">
        {formName}
      </span>
    </nav>
  )
}
