import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useStore } from 'zustand'
import { ChevronRight, Eye, House, Palette, Redo2, Settings, Undo2 } from 'lucide-react'

import { displayFormName, type FormDetail } from '../../../entities/form'
import { useFeatureAllowed } from '../../plan/useFeature'
import { workspacesQueryOptions } from '../../workspaces/queries'
import { useHeaderSlot } from '../../../shared/headerSlot'
import { DesignDrawer } from './DesignDrawer'
import { FormSettings } from './FormSettings'
import { PreviewOverlay } from './PreviewOverlay'
import { PublishControls } from './PublishControls'
import { SaveIndicator, ConflictBanner } from './SaveIndicator'
import { SlashEditor } from './SlashEditor'
import { type FormIdSource } from './mediaUpload'
import { createFocusEngine } from './focusEngine'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { useAutosave, type DraftCreation } from './useAutosave'
import { useGlobalChord } from './useGlobalChord'
import { chords } from './shortcuts'
import { Button } from '@/components/ui/button'

// Что показано вместо полотна. Полотно (edit) — документ из блоков; настройки — то,
// чего на форме не видно (экран после отправки). Режим локальный: F5 возвращает в
// редактор, ссылки на настройки нет (решение владельца).
//
// Просмотра среди режимов НЕТ: он не занимает место полотна, а наезжает на окно
// целиком отдельным слоем (`PreviewOverlay`) — и потому живёт собственным флагом,
// поверх любого режима.
type Mode = 'edit' | 'settings'

// BuilderScreen — редактор в стиле Tally: чистое документное полотно (SlashEditor),
// а все элементы управления (статус сохранения, просмотр, публикация) порталятся в
// верхнюю шапку приложения — в один бар с кнопкой сворачивания сайдбара.
// Стор создаётся один раз на инстанс и сразу гидрируется черновиком; маршрут
// монтирует экран с key={formId}, поэтому переход на другую форму даёт свежий стор.
//
// draft задан, пока формы НЕТ на сервере (ленивое создание, features/forms/draft.ts):
// detail тогда синтетическая, detail.id пуст, и всё, что адресует форму по id,
// спрашивает ensureForm — она заводит форму по первой надобности.
export function BuilderScreen({
  detail,
  draft,
}: {
  detail: FormDetail
  draft?: DraftCreation
}) {
  // Тариф спрашивается ЗДЕСЬ, а не в превью: экран уже живёт внутри провайдера Query и
  // уже ходит в чужие фичи, а превью остаётся чистым видом стора — иначе провайдер
  // потребовался бы каждому, кто его рисует, включая тесты раскладки.
  const canRemoveBadge = useFeatureAllowed('form_branding')
  const [store] = useState(() => {
    const s = createBuilderStore()
    s.getState().hydrate(detail.draftSchema)
    return s
  })

  // Фокус-движок полотна живёт здесь (а не в SlashEditor): он обязан пережить
  // переключение режима edit↔preview (SlashEditor размонтируется) и, главное, дать
  // undo/redo поставить каретку на затронутый блок (§2.4) — отмену дёргает этот
  // экран (клавиатура + кнопки), а не полотно. SlashEditor раздаёт его через контекст.
  const [engine] = useState(() => createFocusEngine())

  const headerSlot = useHeaderSlot()
  const { status, saveNow, ensureForm } = useAutosave(
    store,
    detail.id,
    detail.slug,
    detail.updatedAt,
    draft,
  )
  // Куда грузить картинки. Пока формы нет, вниз уходит не id, а обещание его добыть:
  // обложку автор вправе выбрать первым же действием, раньше любой правки полотна, —
  // и тогда форму заводит она (mediaUpload.FormIdSource).
  const uploadTo: FormIdSource = detail.id || (() => ensureForm().then((f) => f.id))
  const [mode, setMode] = useState<Mode>('edit')
  const [previewOpen, setPreviewOpen] = useState(false)
  // Оформление — НЕ режим, а шторка поверх полотна: автор смотрит на форму, а не на
  // панель, и тема обязана меняться у него на глазах. Режим (как у настроек) закрыл
  // бы полотно и превратил подбор темы в угадывание.
  const [designOpen, setDesignOpen] = useState(false)

  // Отмена/повтор + каретка на первый затронутый откатом блок (§2.4). id приходит из
  // стора; блок мог ещё не смонтироваться (только что восстановлен) — движок поставит
  // фокус, как только строка зарегистрирует цель (pending в focusEngine).
  const undo = () => {
    const id = store.getState().undo()
    if (id) engine.focusBlock(id)
  }
  const redo = () => {
    const id = store.getState().redo()
    if (id) engine.focusBlock(id)
  }

  // Публиковать можно только когда серверный черновик догнал редактор: нет
  // несохранённых правок и последний автосейв успешен (иначе снапшот будет старым).
  const dirty = useStore(store, (s) => s.dirty)
  const canPublish = status === 'saved' && !dirty

  const canUndo = useStore(store, (s) => s.past.length > 0)
  const canRedo = useStore(store, (s) => s.future.length > 0)

  // Горячие клавиши истории на весь экран билдера: Ctrl/Cmd+Z — отмена,
  // Ctrl/Cmd+Shift+Z и Ctrl+Y — повтор. Слушатель живёт вместе с экраном; на
  // документ-уровне перехватываем и внутри textarea полотна (нативный undo поля
  // уступает отмене всего документа — так ведёт себя Notion/Tally). Пустой стек —
  // no-op. Исключение одно и его держит useGlobalChord: поле во всплывающем слое
  // (настройки блока, поиск типа) правит СЕБЯ, а не документ.
  useGlobalChord((e) => {
    // Матчеры по e.code (§3.1, shortcuts.ts): при кириллической (и любой не-латинской)
    // раскладке Ctrl+Z даёт e.key='я', и хоткей молча ломался — срабатывал нативный
    // undo контролируемого textarea (откат по одному символу).
    const isUndo = chords.undo(e)
    const isRedo = chords.redo(e)
    if (!isUndo && !isRedo) return
    e.preventDefault()
    if (isUndo) undo()
    else redo()
  })

  return (
    <BuilderStoreContext.Provider value={store}>
      {/* Кнопки редактора — в верхнюю шапку. Портал сохраняет React-контекст
          (стор/Query доступны), несмотря на другое место в DOM. */}
      {headerSlot &&
        createPortal(
          <div className="flex w-full items-center gap-2">
            <Breadcrumbs formName={displayFormName(detail)} />
            <div className="ml-auto flex items-center gap-2">
              {/* Отмена/повтор — история документа, ближе всего к полотну,
                  которое они правят. */}
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                disabled={!canUndo}
                onClick={undo}
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
                onClick={redo}
                aria-label="Повторить (Ctrl+Shift+Z)"
                title="Повторить (Ctrl+Shift+Z)"
              >
                <Redo2 className="size-4" />
              </Button>
              {/* Просмотр — только ВХОД, не тумблер: слой закрывает шапку целиком,
                  и кнопки, которой можно было бы нажать второй раз, под ним нет.
                  Выход подписан словами на самом слое. */}
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground"
                onClick={() => setPreviewOpen(true)}
              >
                <Eye className="size-4" /> Просмотр
              </Button>
              {/* Оформление — ТУМБЛЕР шторки, а не вход в режим (в отличие от
                  настроек ниже): она выезжает сбоку, ОТОДВИГАЯ оболочку, а не
                  закрывая полотно, и второго выхода мимо чего-либо тут нет —
                  закрывать нечему. Отдельно от настроек ещё и потому, что
                  сохраняется иначе: тема применяется сразу и уезжает автосейвом,
                  настройки — явной кнопкой. Подписана текстом (а не только иконкой,
                  как «Настройки»): рядом с «Просмотр» безымянная иконка палитры
                  читалась бы двусмысленно. */}
              <Button
                variant="ghost"
                size="sm"
                className={designOpen ? 'gap-1.5' : 'gap-1.5 text-muted-foreground'}
                aria-pressed={designOpen}
                onClick={() => setDesignOpen((v) => !v)}
              >
                <Palette className="size-4" /> Оформление
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
              {/* Статус автосейва стоит у самой публикации: именно он решает,
                  активна ли кнопка «Опубликовать» (canPublish). */}
              <SaveIndicator status={status} onRetry={saveNow} />
              <PublishControls form={detail} canPublish={canPublish} ensureForm={ensureForm} />
            </div>
          </div>,
          headerSlot,
        )}

      {status === 'conflict' && <ConflictBanner />}

      {mode === 'edit' && (
        <SlashEditor formId={uploadTo} engine={engine} onOpenDesign={() => setDesignOpen(true)} />
      )}
      {/* Просмотр — слой поверх окна (PreviewOverlay), а внутри слоя — СВОЙ документ
          (TD-60): свой CSS автора обязан быть здесь виден и обязан не покидать фрейм,
          иначе `.rf-input{display:none}` из формы погасил бы поля самого кабинета.
          Стор передаётся пропом — контекст через границу корней React не проходит
          (PreviewFrame.tsx). Закрытым слой ничего не монтирует (Radix не рисует
          содержимое), поэтому держать его здесь всегда дёшево — и только так Radix
          успевает проиграть закрытие. */}
      <PreviewOverlay
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        store={store}
        title={detail.title}
        canRemoveBadge={canRemoveBadge}
      />
      {/* Настройки сохраняются кнопкой, а не автосейвом: saveNow уносит их сразу,
          иначе индикатор ещё 800 мс дебаунса врал бы «не сохранено». */}
      {mode === 'settings' && (
        <FormSettings
          detail={detail}
          ensureForm={ensureForm}
          onBack={() => setMode('edit')}
          onSaved={saveNow}
        />
      )}
      {/* Шторка остаётся смонтированной и в закрытом виде — иначе Radix не успевает
          проиграть закрытие, панель исчезает мгновенно, а оболочка едет назад 300 мс,
          и видно, что это два разных элемента. Урок фазы 21 («закрытые диалоги не
          монтировать») тут не работает против нас: он про диалоги, подписанные на
          s.blocks и потому перерисовывающиеся на каждый символ, а эта панель
          подписана на s.design — он при вводе не меняется. Только в режиме полотна:
          поверх превью или настроек шторке нечего показывать. */}
      {mode === 'edit' && (
        <DesignDrawer formId={uploadTo} open={designOpen} onOpenChange={setDesignOpen} />
      )}
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
        search={(prev) => prev}
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
